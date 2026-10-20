import assert from "node:assert/strict";
import { once } from "node:events";
import { MyMusic5Client } from "../src/index.js";
import { createApiServer } from "../src/http/index.js";

const artist = process.argv[2];
if (!artist) {
    console.error("Usage: node scripts/verify-live.mjs <artistUrl>");
    process.exitCode = 1;
}
else {
    const originals = new Map();
    let upstreamRequests = 0;
    const client = new MyMusic5Client({
        concurrency: 3,
        retries: 1,
        fetch: async (url, init) => {
            upstreamRequests++;
            const response = await fetch(url, init);
            if (response.ok && new URL(url).pathname.includes("/public/sheet/")) {
                const original = await response.clone().json();
                originals.set(original.sheetId, original);
            }
            return response;
        },
    });
    const server = createApiServer({ client });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
        const sheets = [];
        let path = `/v1/artists/${encodeURIComponent(artist)}/sheets?pageSize=10`;
        let total;
        let pages = 0;
        while (path) {
            const response = await fetch(`${base}${path}`, { signal: controller.signal });
            const result = await response.json();
            assert.equal(response.status, 200, JSON.stringify(result));
            total ??= result.pagination.total;
            assert.equal(result.pagination.total, total);
            for (const value of result.data) assert.deepEqual(value, originals.get(value.sheetId));
            sheets.push(...result.data);
            path = result.links.next;
            pages++;
            assert.ok(pages <= Math.max(1, Math.ceil(total / 10)));
        }
        assert.equal(sheets.length, total);
        assert.equal(new Set(sheets.map((value) => value.sheetId)).size, total);
        assert.equal(sheets.every((value) => value.author.artistUrl.toLowerCase() === artist.toLowerCase()), true);
        let detailFields = 0;
        if (sheets.length) {
            const response = await fetch(`${base}/v1/sheets/${sheets[0].sheetId}`, { signal: controller.signal });
            const result = await response.json();
            assert.equal(response.status, 200);
            assert.deepEqual(result.data, originals.get(sheets[0].sheetId));
            detailFields = Object.keys(result.data).length;
        }
        const ascending = await client.artists.listSheets(artist, { pageSize: 2, sort: "createdAt", signal: controller.signal });
        if (ascending.data.length === 2) {
            assert.ok(Date.parse(ascending.data[0].createdAt) <= Date.parse(ascending.data[1].createdAt));
        }
        console.log(JSON.stringify({
            artist,
            total,
            pages,
            paid: sheets.filter((value) => value.isFree === false).length,
            free: sheets.filter((value) => value.isFree === true).length,
            fieldsPreserved: true,
            detailFields,
            ascendingSortVerified: true,
            upstreamRequests,
        }, null, 4));
    }
    finally {
        clearTimeout(timeout);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
