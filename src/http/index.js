import { createServer } from "node:http";
import { MyMusic5Client, MyMusic5Error } from "../index.js";
import { invalid } from "../core/errors.js";

function decodeSegment(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        throw invalid("The resource identifier contains invalid URL encoding.");
    }
}

function queryOptions(searchParams, allowed) {
    const values = {};
    for (const [key, value] of searchParams) {
        if (!allowed.includes(key)) throw invalid(`Unsupported query parameter: ${key}.`);
        if (Object.hasOwn(values, key)) throw invalid(`Query parameter ${key} must occur only once.`);
        if (key === "page" || key === "pageSize") {
            if (!/^[1-9]\d*$/.test(value)) throw invalid(`${key} must be a positive integer.`);
            values[key] = Number(value);
        }
        else {
            values[key] = value;
        }
    }
    return values;
}

function sendJson(request, response, status, payload, contentType = "application/json") {
    if (response.destroyed) return;
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
}

export function createApiHandler({ client = new MyMusic5Client() } = {}) {
    return async function handler(request, response) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const onClose = () => {
            if (!response.writableEnded) abort();
        };
        request.once("aborted", abort);
        response.once("close", onClose);
        try {
            const url = new URL(request.url, "http://localhost");
            const sheetMatch = /^\/v1\/sheets\/([^/]+)$/.exec(url.pathname);
            const artistMatch = /^\/v1\/artists\/([^/]+)\/sheets$/.exec(url.pathname);
            if (!sheetMatch && !artistMatch) {
                throw new MyMusic5Error("ROUTE_NOT_FOUND", "The requested resource does not exist.", { status: 404 });
            }
            if (request.method !== "GET" && request.method !== "HEAD") {
                response.setHeader("Allow", "GET, HEAD");
                throw new MyMusic5Error("METHOD_NOT_ALLOWED", "This resource supports GET and HEAD.", { status: 405 });
            }
            if (sheetMatch) {
                queryOptions(url.searchParams, []);
                const data = await client.sheets.get(decodeSegment(sheetMatch[1]), { signal: controller.signal });
                sendJson(request, response, 200, {
                    data,
                    links: { self: `/v1/sheets/${data.sheetId}` },
                    meta: { fetchedAt: new Date().toISOString() },
                });
            }
            else {
                const options = queryOptions(url.searchParams, ["page", "pageSize", "sort"]);
                const result = await client.artists.listSheets(decodeSegment(artistMatch[1]), {
                    ...options, signal: controller.signal,
                });
                response.setHeader("Link", Object.entries(result.links)
                    .filter(([, link]) => link !== null)
                    .map(([relation, link]) => `<${link}>; rel="${relation === "previous" ? "prev" : relation}"`)
                    .join(", "));
                sendJson(request, response, 200, result);
            }
        }
        catch (error) {
            const known = error instanceof MyMusic5Error;
            const status = known ? error.status : 500;
            if (known && error.retryAfter !== undefined) response.setHeader("Retry-After", String(error.retryAfter));
            sendJson(request, response, status, {
                type: "about:blank",
                title: status === 400 ? "Bad Request"
                    : status === 404 ? "Not Found"
                        : status === 405 ? "Method Not Allowed"
                            : status === 408 ? "Request Timeout"
                                : status === 503 ? "Service Unavailable"
                                    : status === 504 ? "Gateway Timeout"
                                        : status === 502 ? "Bad Gateway" : "Internal Server Error",
                status,
                code: known ? error.code : "INTERNAL_ERROR",
                detail: known ? error.message : "An unexpected server error occurred.",
            }, "application/problem+json");
        }
        finally {
            request.off("aborted", abort);
            response.off("close", onClose);
        }
    };
}

export function createApiServer(options = {}) {
    const server = createServer(createApiHandler(options));
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    return server;
}
