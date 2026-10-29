# MyMusic5API

An unofficial, read-only [MyMusic5](https://www.mymusic5.com/) REST API and JavaScript library, sharing one core. Requires Node.js 22 or newer.

Read the [documentation](https://lunaticghoulpiano.github.io/documentations/mymusic5-api/) for setup, API reference, and examples.

## Run the HTTP API

```sh
node src/cli.js
```

The default address is `http://127.0.0.1:3000`. Set `HOST` and `PORT` to change it. The server closes on SIGINT or SIGTERM. Importing the library never starts a server.

| Method | Resource | Description |
| --- | --- | --- |
| GET, HEAD | `/v1/sheets/{sheetId}` | Complete public sheet details |
| GET, HEAD | `/v1/artists/{artistUrl}/sheets` | A page of complete public sheet details |

Collection query parameters:

| Parameter | Default | Values |
| --- | --- | --- |
| `page` | `1` | Positive integer |
| `pageSize` | `20` | Integer from 1 to 100 |
| `sort` | `-createdAt` | `-createdAt` (newest first), `createdAt` (oldest first) |

Unsupported or repeated query parameters return 400 instead of being silently ignored. Writes return 405 with `Allow: GET, HEAD`. No account or API key is needed for these public metadata operations.

A detail response has `data`, `links.self`, and `meta.fetchedAt`. A collection response has:

```json
{
    "data": [],
    "pagination": {
        "page": 1,
        "pageSize": 20,
        "total": 0,
        "totalPages": 0
    },
    "links": {
        "self": "/v1/artists/example-artist/sheets?page=1&pageSize=20&sort=-createdAt",
        "next": null,
        "previous": null
    },
    "meta": {
        "fetchedAt": "2026-01-01T00:00:00.000Z"
    }
}
```

Follow `links.next` until it is `null` to retrieve every page. Responses also include an HTTP `Link` header. A page beyond the last page returns an empty array. An empty collection cannot distinguish an artist with no public sheets from a nonexistent artist; this version does not claim to verify artist profiles.

## Use the library

Within this repository, import from `./src/index.js`. Package consumers use `mymusic5-api` after installing the package from a local checkout or a published release; no registry publication is implied by this repository.

```js
import { MyMusic5Client } from "./src/index.js";

const client = new MyMusic5Client();
const artist = process.env.ARTIST_URL;
const id = process.env.SHEET_ID;

const sheet = await client.sheets.get(id);
const page = await client.artists.listSheets(artist, { page: 1, pageSize: 10 });
const collection = await client.artists.collectSheets(artist, { pageSize: 10 });

for await (const item of client.artists.iterateSheets(artist, { pageSize: 10 })) {
    console.log(item.sheetId, item.title);
}
```

`get()` returns the original public sheet object. `listSheets()` returns the same envelope as the REST collection route. `collectSheets()` returns `{ data, meta: { total, pages, complete, fetchedAt } }` only after a complete traversal succeeds. `iterateSheetPages()` yields page envelopes; `iterateSheets()` yields individual sheets.

An iterator can yield earlier pages before a later page fails. Its consumer must handle errors and must not claim completion before iteration ends. Use `collectSheets()` when callers need an all-or-error result. Early termination of an iterator stops fetching subsequent pages.

The HTTP adapter uses these same methods:

```js
import { MyMusic5Client } from "./src/index.js";
import { createApiServer } from "./src/http/index.js";

const client = new MyMusic5Client({ concurrency: 3, timeoutMs: 15_000 });
const server = createApiServer({ client });
server.listen(3000, "127.0.0.1");
```

The package subpath for the HTTP adapter is `mymusic5-api/http`. `createApiHandler({ client })` can also be attached to an existing Node HTTP server.

## Public field preservation

The upstream public detail response is returned unchanged as a JSON object. This includes unknown future fields, nested author/file/tag/SEO information, nulls, prices, and free/paid flags. Only resource identity and collection ownership are checked; no allowlist strips public fields. Description markup and timestamp strings are not rewritten. JSON property order, whitespace, and transport bytes are not part of the contract.

There is no duplicate `raw` copy because `data` already contains the complete upstream object. The API adds pagination and fetch metadata outside it. `updatedAt` is preserved as reported by MyMusic5 and does not establish when the score file was revised. Timezone-less timestamps are not assigned an invented timezone.

GraphQL supplies page membership and total counts. The public sheet endpoint supplies complete details for each member. Consequently, a page of N sheets normally requires 1 + N upstream requests; details are fetched with bounded concurrency and returned in the original page order. No filtering to free works or a specific publication status is applied. The API retrieves public metadata, including preview/file metadata, and does not download purchased score files or access private account data.

Upstream sources:

- `POST https://mms.pd.mapia.io/mms/graphql`
- `GET https://mms.pd.mapia.io/mms/public/sheet/{sheetId}`

These are website interfaces rather than a guaranteed public developer contract. Global search, independent artist profiles, private data, and other resource families are outside this first implementation.

## Reliability and configuration

`MyMusic5Client` accepts these options:

| Option | Default | Purpose |
| --- | --- | --- |
| `timeoutMs` | 15000 | Timeout per upstream attempt, including reading JSON |
| `retries` | 2 | Retries for network failures, timeouts, HTTP 429 and 5xx; maximum 5 |
| `retryDelayMs` | 250 | Initial exponential retry delay |
| `maxRetryDelayMs` | 30000 | Maximum retry wait; longer Retry-After responses fail without retrying early |
| `concurrency` | 4 | Maximum parallel detail requests per page; maximum 20 |
| `pageSize` | 20 | Default collection page size; maximum 100 |
| `maxPages` | 1000 | Maximum pages for complete collection and iterators |
| `fetch` | Global fetch | Inject a transport for testing or instrumentation |
| `baseUrl` | MyMusic5 upstream | Trusted application configuration, never an HTTP query parameter |

These limits are application defaults, not documented MyMusic5 quotas. Pass an `AbortSignal` to each library operation to impose a total deadline or cancel it. Client HTTP disconnects cancel associated upstream work. This initial server does not add caching, public-service authentication, or a local rate limiter.

Complete traversal detects changed totals, missing entries, duplicate IDs, and mismatched authors. It throws if a page limit is reached or any detail is unavailable, rather than silently returning partial data. MyMusic5's page-based interface is not an atomic snapshot: concurrent changes that leave totals and observed membership consistent cannot always be detected.

Errors use `MyMusic5Error` in the library and `application/problem+json` over HTTP:

- 400: invalid arguments.
- 404: unknown route or public detail endpoint returning not found.
- 405: unsupported HTTP method.
- 408: cancelled operation.
- 502: upstream HTTP/GraphQL failures, invalid data, or incomplete pagination.
- 503: upstream rate limiting; `Retry-After` is forwarded when available.
- 504: upstream timeout.
- 500: unexpected server error, without internal diagnostics.

Error responses contain `type`, `title`, `status`, `code`, and `detail`. Failed requests do not return a successful partial `data` array. Upstream diagnostic bodies are not copied into error responses.

## Test

```sh
node --test test/*.test.js
```

The normal suite uses deterministic fixtures and local HTTP servers. It does not contact MyMusic5. It covers different artists and counts, complete and partial pages, paid/free records, full field preservation, cancellation, retry behavior, and HTTP semantics.

Run an explicit live contract check with any public artist handle:

```sh
node scripts/verify-live.mjs <artistUrl>
```

This follows the REST pagination links, compares every returned sheet with its complete upstream JSON response, checks unique IDs and reported totals, and exercises the detail route and oldest-first sorting. It only reads public metadata, writes no snapshots, and closes its temporary local server.

## License

Apache-2.0. See [LICENSE](LICENSE).
