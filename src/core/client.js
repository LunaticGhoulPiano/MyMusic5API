import { defaults } from "./config.js";
import { assertActive, invalid, MyMusic5Error, upstream } from "./errors.js";
import { createTransport } from "./transport.js";
import { artistUrl, integer, isObject, sheetId } from "./validation.js";

const artistSheetsQuery = `query ArtistSheets($data: SheetSearchInput!) {
    sheetSearch(data: $data) {
        list { sheetId author { artistUrl } }
        total current listNum
    }
}`;

function validateOptions(options) {
    const result = { ...defaults, ...options };
    integer(result.timeoutMs, "timeoutMs", 1, 2_147_483_647);
    integer(result.retries, "retries", 0, 5);
    integer(result.retryDelayMs, "retryDelayMs", 0, 60_000);
    integer(result.maxRetryDelayMs, "maxRetryDelayMs", 0, 60_000);
    integer(result.concurrency, "concurrency", 1, 20);
    integer(result.pageSize, "pageSize", 1, defaults.maxPageSize);
    integer(result.maxPages, "maxPages");
    if (result.fetch !== undefined && typeof result.fetch !== "function") throw invalid("fetch must be a function.");
    try {
        const url = new URL(result.baseUrl);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error("Invalid base URL.");
        }
        result.baseUrl = url.href.endsWith("/") ? url.href : `${url.href}/`;
    }
    catch {
        throw invalid("baseUrl must be an HTTP(S) URL without credentials, a query, or a fragment.");
    }
    return result;
}

function validateSort(sort) {
    if (sort !== "-createdAt" && sort !== "createdAt") throw invalid("sort must be -createdAt or createdAt.");
    return sort;
}

function sameArtist(actual, expected) {
    return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
}

function pageLinks(artist, page, pageSize, totalPages, sort) {
    const link = (number) => `/v1/artists/${encodeURIComponent(artist)}/sheets?${new URLSearchParams({
        page: String(number), pageSize: String(pageSize), sort,
    })}`;
    return {
        self: link(page),
        next: page < totalPages ? link(page + 1) : null,
        previous: page > 1 ? link(page - 1) : null,
    };
}

async function mapConcurrent(items, concurrency, signal, mapper) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const results = new Array(items.length);
    let cursor = 0;
    let failure;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length && !failure) {
            const index = cursor++;
            try {
                assertActive(combined);
                results[index] = await mapper(items[index], combined);
            }
            catch (error) {
                failure ??= error;
                controller.abort();
            }
        }
    }));
    if (failure) throw failure;
    assertActive(signal);
    return results;
}

export class MyMusic5Client {
    #options;
    #request;

    constructor(options = {}) {
        this.#options = validateOptions(options);
        this.#request = createTransport(this.#options);
        this.sheets = Object.freeze({ get: this.#getSheet.bind(this) });
        this.artists = Object.freeze({
            listSheets: this.#listSheets.bind(this),
            iterateSheetPages: this.#iterateSheetPages.bind(this),
            iterateSheets: this.#iterateSheets.bind(this),
            collectSheets: this.#collectSheets.bind(this),
        });
    }

    async #getSheet(id, { signal } = {}) {
        id = sheetId(id);
        const sheet = await this.#request(`public/sheet/${id}`, { signal, allowNotFound: true });
        if (!isObject(sheet) || sheet.sheetId !== id) {
            throw upstream("MyMusic5 returned a sheet with an invalid or unexpected ID.");
        }
        return sheet;
    }

    async #listSheets(artist, { page = 1, pageSize = this.#options.pageSize, sort = "-createdAt", signal } = {}) {
        artist = artistUrl(artist);
        integer(page, "page");
        integer(pageSize, "pageSize", 1, defaults.maxPageSize);
        integer((page - 1) * pageSize, "page offset", 0);
        validateSort(sort);
        assertActive(signal);
        const response = await this.#request("graphql", {
            signal,
            body: {
                operationName: "ArtistSheets",
                query: artistSheetsQuery,
                variables: { data: {
                    artistUrl: artist,
                    isFree: null,
                    paginate: "page",
                    listNum: pageSize,
                    page,
                    orderBy: { createdAt: sort === "createdAt" ? "ASC" : "DESC" },
                } },
            },
        });
        if (!isObject(response) || (response.errors !== undefined
            && (!Array.isArray(response.errors) || response.errors.length > 0))) {
            throw upstream("MyMusic5 returned a GraphQL error; no partial page was returned.");
        }
        const result = response.data?.sheetSearch;
        if (!isObject(result) || !Array.isArray(result.list)
            || !Number.isSafeInteger(result.total) || result.total < 0
            || result.current !== page || result.listNum !== pageSize) {
            throw upstream("MyMusic5 returned invalid pagination metadata.");
        }
        const expectedLength = Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize));
        if (result.list.length !== expectedLength) {
            throw upstream("MyMusic5 returned an incomplete page.");
        }
        const ids = new Set();
        for (const item of result.list) {
            if (!isObject(item) || !Number.isSafeInteger(item.sheetId) || item.sheetId < 1
                || ids.has(item.sheetId) || !sameArtist(item.author?.artistUrl, artist)) {
                throw upstream("MyMusic5 returned a duplicate sheet, invalid ID, or unexpected artist.");
            }
            ids.add(item.sheetId);
        }
        const data = await mapConcurrent(result.list, this.#options.concurrency, signal, async (item, requestSignal) => {
            const sheet = await this.#getSheet(item.sheetId, { signal: requestSignal });
            if (!sameArtist(sheet.author?.artistUrl, artist)) {
                throw upstream("The sheet details do not belong to the requested artist.");
            }
            return sheet;
        });
        const totalPages = Math.ceil(result.total / pageSize);
        return {
            data,
            pagination: { page, pageSize, total: result.total, totalPages },
            links: pageLinks(artist, page, pageSize, totalPages, sort),
            meta: { fetchedAt: new Date().toISOString() },
        };
    }

    async *#iterateSheetPages(artist, { pageSize = this.#options.pageSize, sort = "-createdAt", signal } = {}) {
        const seen = new Set();
        let total;
        for (let page = 1; page <= this.#options.maxPages; page++) {
            const result = await this.#listSheets(artist, { page, pageSize, sort, signal });
            total ??= result.pagination.total;
            if (total !== result.pagination.total || result.data.some((sheet) => seen.has(sheet.sheetId))) {
                throw new MyMusic5Error("PAGINATION_CHANGED", "The catalog changed during pagination; collection is incomplete.");
            }
            for (const sheet of result.data) seen.add(sheet.sheetId);
            yield result;
            if (seen.size === total) return;
        }
        throw new MyMusic5Error("PAGINATION_LIMIT", "The configured page limit was reached; collection is incomplete.");
    }

    async *#iterateSheets(artist, options = {}) {
        for await (const page of this.#iterateSheetPages(artist, options)) yield* page.data;
    }

    async #collectSheets(artist, options = {}) {
        const data = [];
        let pages = 0;
        for await (const page of this.#iterateSheetPages(artist, options)) {
            data.push(...page.data);
            pages++;
        }
        return { data, meta: { total: data.length, pages, complete: true, fetchedAt: new Date().toISOString() } };
    }
}
