import assert from "node:assert/strict";
import test from "node:test";
import { MyMusic5Client, MyMusic5Error } from "../src/index.js";
import { fixture, json, sheet } from "./helpers.js";

const code = (expected) => (error) => error instanceof MyMusic5Error && error.code === expected;

test("sheet details preserve every field, nested value, null, HTML, and timestamp", async () => {
    const { client, sheets } = fixture();
    assert.deepEqual(await client.sheets.get("23"), sheets[0]);
    assert.equal((await client.sheets.get(23)).isFree, false);
});

for (const count of [0, 1, 20, 23, 37]) {
    test(`complete pagination for ${count} sheets includes both paid and free works`, async () => {
        const { client, calls, sheets } = fixture({ count });
        const result = await client.artists.collectSheets("fixture-artist", { pageSize: 10 });
        assert.deepEqual(result.data, sheets);
        assert.equal(result.meta.complete, true);
        assert.equal(result.meta.total, count);
        assert.equal(result.meta.pages, Math.max(1, Math.ceil(count / 10)));
        assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/graphql")).length, result.meta.pages);
        assert.equal(calls.length, result.meta.pages + count);
    });
}

test("page links, beyond-last pages, and ascending sort are consistent", async () => {
    const { client, sheets } = fixture({ count: 23 });
    const page = await client.artists.listSheets("fixture-artist", { page: 2, pageSize: 10 });
    assert.deepEqual(page.data, sheets.slice(10, 20));
    assert.deepEqual(page.pagination, { page: 2, pageSize: 10, total: 23, totalPages: 3 });
    assert.match(page.links.next, /page=3&pageSize=10&sort=-createdAt$/);
    assert.match(page.links.previous, /page=1&pageSize=10/);
    const beyond = await client.artists.listSheets("fixture-artist", { page: 8, pageSize: 10 });
    assert.deepEqual(beyond.data, []);
    assert.equal(beyond.links.next, null);
    const oldest = await client.artists.collectSheets("fixture-artist", { pageSize: 10, sort: "createdAt" });
    assert.deepEqual(oldest.data, [...sheets].reverse());
});

test("a different artist and Unicode handle are not replaced with a fixed author", async () => {
    const artist = "音樂-example_2";
    const { client, sheets } = fixture({ artist, count: 4 });
    const page = await client.artists.listSheets(artist);
    assert.deepEqual(page.data, sheets);
    assert.ok(page.links.self.includes(encodeURIComponent(artist)));
});

test("detail concurrency is bounded and preserves upstream page order", async () => {
    const { client, sheets, maxActive } = fixture({ count: 11, delay: 5, options: { concurrency: 3 } });
    const result = await client.artists.collectSheets("fixture-artist");
    assert.deepEqual(result.data, sheets);
    assert.equal(maxActive(), 3);
});

test("async iterators yield full sheets and can stop without fetching later pages", async () => {
    const { client, calls, sheets } = fixture({ count: 23 });
    for await (const value of client.artists.iterateSheets("fixture-artist", { pageSize: 5 })) {
        assert.deepEqual(value, sheets[0]);
        break;
    }
    assert.equal(calls.length, 6);
});

test("collecting fails instead of returning an incomplete result at the page limit", async () => {
    const { client } = fixture({ count: 3, options: { maxPages: 1 } });
    await assert.rejects(client.artists.collectSheets("fixture-artist", { pageSize: 2 }), code("PAGINATION_LIMIT"));
});

test("changing totals and cross-page duplicates fail complete collection", async () => {
    for (const change of ["total", "duplicate"]) {
        const { client } = fixture({ count: 6, mutatePage(result, options) {
            if (options.page === 2) {
                if (change === "total") result.total++;
                else result.list[0].sheetId = 6;
            }
            return { data: { sheetSearch: result } };
        } });
        await assert.rejects(client.artists.collectSheets("fixture-artist", { pageSize: 2 }), code("PAGINATION_CHANGED"));
    }
});

for (const [name, mutate] of [
    ["partial page", (result) => result.list.pop()],
    ["duplicate IDs", (result) => result.list[1] = result.list[0]],
    ["wrong owner", (result) => result.list[0].author.artistUrl = "someone-else"],
    ["wrong page", (result) => result.current++],
    ["wrong page size", (result) => result.listNum++],
    ["invalid total", (result) => result.total = -1],
    ["invalid ID", (result) => result.list[0].sheetId = "10"],
]) {
    test(`rejects ${name}`, async () => {
        const { client } = fixture({ mutatePage(result) {
            mutate(result);
            return { data: { sheetSearch: result } };
        } });
        await assert.rejects(client.artists.listSheets("fixture-artist"), code("INVALID_UPSTREAM_RESPONSE"));
    });
}

test("GraphQL errors in HTTP 200 never become empty successful pages", async () => {
    for (const payload of [null, {}, { data: null }, { errors: [{ message: "secret upstream detail" }], data: {} }]) {
        const client = new MyMusic5Client({ fetch: async () => json(payload), retries: 0 });
        await assert.rejects(client.artists.listSheets("fixture-artist"), code("INVALID_UPSTREAM_RESPONSE"));
    }
});

test("detail failures, mismatched sheet IDs, and mismatched owners reject the entire page", async () => {
    for (const mutateSheet of [
        (value) => ({ ...value, sheetId: 999 }),
        (value) => ({ ...value, author: { artistUrl: "another-artist" } }),
        () => null,
    ]) {
        const { client } = fixture({ mutateSheet });
        await assert.rejects(client.artists.listSheets("fixture-artist"), code("INVALID_UPSTREAM_RESPONSE"));
    }
});

test("invalid arguments are rejected before upstream requests", async () => {
    let requests = 0;
    const client = new MyMusic5Client({ fetch: async () => { requests++; return json({}); } });
    for (const id of [0, -1, 1.5, "1e2", "01", "1/2", Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(client.sheets.get(id), code("INVALID_ARGUMENT"));
    }
    for (const artist of ["", "../someone", "bad?artist", "bad%2Fartist", " has-space", "..", null]) {
        await assert.rejects(client.artists.listSheets(artist), code("INVALID_ARGUMENT"));
    }
    for (const options of [{ page: 0 }, { pageSize: 101 }, { page: "1" }, { sort: "price" }, { page: Number.MAX_SAFE_INTEGER }]) {
        await assert.rejects(client.artists.listSheets("fixture-artist", options), code("INVALID_ARGUMENT"));
    }
    assert.equal(requests, 0);
});

test("invalid configuration is rejected", () => {
    for (const options of [{ concurrency: 0 }, { retries: 6 }, { timeoutMs: 0 }, { baseUrl: "file:///tmp/" }, { baseUrl: "https://u:p@example.test" }]) {
        assert.throws(() => new MyMusic5Client(options), code("INVALID_ARGUMENT"));
    }
});

test("cancellation before requests and between pages is propagated", async () => {
    const controller = new AbortController();
    const { client, calls } = fixture({ count: 4 });
    controller.abort();
    await assert.rejects(client.sheets.get(4, { signal: controller.signal }), code("REQUEST_ABORTED"));
    assert.equal(calls.length, 0);
    const active = new AbortController();
    const iterator = client.artists.iterateSheetPages("fixture-artist", { pageSize: 2, signal: active.signal });
    await iterator.next();
    active.abort();
    await assert.rejects(iterator.next(), code("REQUEST_ABORTED"));
    assert.equal(calls.length, 3);
});

test("typed not-found and invalid-JSON errors", async () => {
    const missing = new MyMusic5Client({ fetch: async () => json({}, 404), retries: 0 });
    await assert.rejects(missing.sheets.get(1), (error) => error.status === 404 && error.code === "SHEET_NOT_FOUND");
    const broken = new MyMusic5Client({ fetch: async () => new Response("not JSON"), retries: 0 });
    await assert.rejects(broken.sheets.get(1), code("INVALID_UPSTREAM_RESPONSE"));
});

test("transient HTTP failures and network failures retry with bounded attempts", async () => {
    for (const status of [429, 503, "network"]) {
        let attempts = 0;
        const client = new MyMusic5Client({ retries: 2, retryDelayMs: 0, fetch: async () => {
            attempts++;
            if (attempts < 3) {
                if (status === "network") throw new Error("connection details");
                return json({}, status, { "Retry-After": "0" });
            }
            return json(sheet(1));
        } });
        assert.equal((await client.sheets.get(1)).sheetId, 1);
        assert.equal(attempts, 3);
    }
});

test("long Retry-After does not cause early retries, and exhausted failures remain failures", async () => {
    let attempts = 0;
    const limited = new MyMusic5Client({ fetch: async () => { attempts++; return json({}, 429, { "Retry-After": "120" }); } });
    await assert.rejects(limited.sheets.get(1), (error) => error.status === 503 && error.retryAfter === 120);
    assert.equal(attempts, 1);
    const failed = new MyMusic5Client({ retries: 1, retryDelayMs: 0, fetch: async () => { attempts++; return json({}, 503); } });
    await assert.rejects(failed.sheets.get(1), code("UPSTREAM_HTTP_ERROR"));
    assert.equal(attempts, 3);
});

test("timeouts and cancellation during a request are distinguished", async () => {
    const request = async (url, { signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1_000);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
    const client = new MyMusic5Client({ fetch: request, timeoutMs: 20, retries: 0 });
    await assert.rejects(client.sheets.get(1), (error) => error.code === "UPSTREAM_TIMEOUT" && error.status === 504);
    const controller = new AbortController();
    const pending = client.sheets.get(1, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, code("REQUEST_ABORTED"));
});
