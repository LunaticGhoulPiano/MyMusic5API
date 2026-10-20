import assert from "node:assert/strict";
import { MyMusic5Client } from "../src/index.js";

export function sheet(id, artist = "fixture-artist", overrides = {}) {
    return {
        sheetId: id,
        title: `Sheet ${id}`,
        description: "<p>Original &amp; unchanged</p>\nSecond line",
        createdAt: "2025-03-04T12:13:14",
        updatedAt: "2026-01-02T03:04:05+00:00",
        isFree: id % 2 === 0,
        price: id % 2 === 0 ? 0 : 4,
        currency: "USD",
        status: "A_FUTURE_PUBLIC_STATUS",
        author: { artistUrl: artist, name: "An artist", optionalValue: null, future: { untouched: true } },
        files: [{ fileName: "Score.pdf", pages: 7, previews: ["https://example.test/preview.webp"], future: [null, { x: 1 }] }],
        tags: [{ tagId: 8, localized: { en: "Piano", "zh-TW": "鋼琴" } }],
        futureField: { nested: [false, 0, null, ""] },
        ...overrides,
    };
}

export function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function fixture({ count = 23, artist = "fixture-artist", mutatePage, mutateSheet, delay = 0, options = {} } = {}) {
    const calls = [];
    const sheets = Array.from({ length: count }, (_, index) => sheet(count - index, artist));
    let active = 0;
    let maxActive = 0;
    const request = async (input, init) => {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.pathname.endsWith("/graphql")) {
            const body = JSON.parse(init.body);
            const data = body.variables.data;
            assert.equal(data.artistUrl, artist);
            assert.equal(data.isFree, null);
            assert.equal(data.paginate, "page");
            assert.equal(body.operationName, "ArtistSheets");
            const ordered = data.orderBy.createdAt === "ASC" ? [...sheets].reverse() : sheets;
            const offset = (data.page - 1) * data.listNum;
            const result = {
                list: ordered.slice(offset, offset + data.listNum).map(({ sheetId, author }) => ({ sheetId, author })),
                total: count,
                current: data.page,
                listNum: data.listNum,
            };
            return json(mutatePage ? mutatePage(result, data) : { data: { sheetSearch: result } });
        }
        const id = Number(url.pathname.split("/").at(-1));
        const value = sheets.find((item) => item.sheetId === id);
        if (!value) return json({ message: "Not found" }, 404);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            return json(mutateSheet ? mutateSheet(value) : value);
        }
        finally {
            active--;
        }
    };
    return {
        client: new MyMusic5Client({ fetch: request, retries: 0, ...options }),
        request,
        calls,
        sheets,
        maxActive: () => maxActive,
    };
}
