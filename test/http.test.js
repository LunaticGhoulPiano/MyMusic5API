import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MyMusic5Client } from "../src/index.js";
import { createApiServer } from "../src/http/index.js";
import { fixture, json } from "./helpers.js";

async function start(t, client) {
    const server = createApiServer({ client });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test("REST details return the complete public upstream object", async (t) => {
    const { client, sheets } = fixture();
    const base = await start(t, client);
    const response = await fetch(`${base}/v1/sheets/23`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const payload = await response.json();
    assert.deepEqual(payload.data, sheets[0]);
    assert.equal(payload.links.self, "/v1/sheets/23");
    assert.ok(Number.isFinite(Date.parse(payload.meta.fetchedAt)));
});

test("REST next links traverse the complete collection without losing fields or paid works", async (t) => {
    const { client, sheets } = fixture({ count: 13, artist: "another-artist" });
    const base = await start(t, client);
    const collected = [];
    let path = "/v1/artists/another-artist/sheets?pageSize=5";
    let pages = 0;
    while (path) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("link"), /rel="self"/);
        const payload = await response.json();
        assert.equal(payload.pagination.total, 13);
        collected.push(...payload.data);
        path = payload.links.next;
        pages++;
    }
    assert.equal(pages, 3);
    assert.deepEqual(collected, sheets);
});

test("HEAD has the same resource headers and no response body", async (t) => {
    const { client } = fixture();
    const base = await start(t, client);
    const response = await fetch(`${base}/v1/sheets/23`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get("content-length")) > 0);
    assert.equal(await response.text(), "");
});

test("invalid queries, identifiers, and repeated parameters return 400 without upstream traffic", async (t) => {
    const { client, calls } = fixture();
    const base = await start(t, client);
    for (const path of [
        "/v1/sheets/abc", "/v1/sheets/1?raw=true", "/v1/sheets/%ZZ",
        "/v1/artists/a%2Fb/sheets", "/v1/artists/artist/sheets?page=0",
        "/v1/artists/artist/sheets?pageSize=101", "/v1/artists/artist/sheets?page=1&page=2",
        "/v1/artists/artist/sheets?sort=price", "/v1/artists/artist/sheets?unknown=1",
    ]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 400, path);
        assert.match(response.headers.get("content-type"), /^application\/problem\+json/);
        assert.equal((await response.json()).code, "INVALID_ARGUMENT");
    }
    assert.equal(calls.length, 0);
});

test("resource and method errors follow HTTP semantics", async (t) => {
    const { client, calls } = fixture();
    const base = await start(t, client);
    const missing = await fetch(`${base}/v1/unknown`);
    assert.equal(missing.status, 404);
    const post = await fetch(`${base}/v1/sheets/1`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    assert.equal(calls.length, 0);
    const missingSheet = await fetch(`${base}/v1/sheets/999`);
    assert.equal(missingSheet.status, 404);
    assert.equal((await missingSheet.json()).code, "SHEET_NOT_FOUND");
});

test("empty collections are 200 and do not imply a verified artist profile", async (t) => {
    const { client } = fixture({ count: 0 });
    const base = await start(t, client);
    const response = await fetch(`${base}/v1/artists/fixture-artist/sheets`);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.data, []);
    assert.equal(value.pagination.total, 0);
    assert.equal(value.links.next, null);
});

test("upstream failures do not leak partial records or upstream secrets", async (t) => {
    const client = new MyMusic5Client({ retries: 0, fetch: async () => json({ errors: [{ message: "private diagnostic" }] }) });
    const base = await start(t, client);
    const response = await fetch(`${base}/v1/artists/fixture-artist/sheets`);
    assert.equal(response.status, 502);
    const value = await response.json();
    assert.equal(value.code, "INVALID_UPSTREAM_RESPONSE");
    assert.equal(Object.hasOwn(value, "data"), false);
    assert.equal(JSON.stringify(value).includes("private diagnostic"), false);
});

test("upstream throttling exposes Retry-After without claiming a local client rate limit", async (t) => {
    const client = new MyMusic5Client({ retries: 0, fetch: async () => json({}, 429, { "Retry-After": "60" }) });
    const base = await start(t, client);
    const response = await fetch(`${base}/v1/sheets/1`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal((await response.json()).code, "UPSTREAM_RATE_LIMITED");
});

test("unexpected implementation errors produce a generic 500 response", async (t) => {
    const client = { sheets: { get: async () => { throw new Error("secret details"); } } };
    const base = await start(t, client);
    const response = await fetch(`${base}/v1/sheets/1`);
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes("secret details"), false);
});

test("disconnecting an HTTP client cancels its upstream operation", { timeout: 2_000 }, async (t) => {
    let notifyStarted;
    let notifyAborted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const aborted = new Promise((resolve) => { notifyAborted = resolve; });
    const client = {
        sheets: {
            get: async (id, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener("abort", () => {
                    notifyAborted();
                    reject(new Error("cancelled"));
                }, { once: true });
                notifyStarted();
            }),
        },
    };
    const base = await start(t, client);
    const controller = new AbortController();
    const pending = fetch(`${base}/v1/sheets/1`, { signal: controller.signal });
    await started;
    const rejection = assert.rejects(pending, (error) => error.name === "AbortError");
    controller.abort();
    await Promise.all([rejection, aborted]);
});
