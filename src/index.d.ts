export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
    [key: string]: JsonValue | undefined;
}

export interface Sheet {
    sheetId: number;
    title?: string | null;
    author?: { artistUrl?: string | null; [key: string]: JsonValue | undefined } | null;
    isFree?: boolean | null;
    price?: number | null;
    currency?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    [key: string]: JsonValue | undefined;
}

export interface ClientOptions {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    concurrency?: number;
    pageSize?: number;
    maxPages?: number;
}

export interface RequestOptions {
    signal?: AbortSignal;
}

export interface CollectionOptions extends RequestOptions {
    pageSize?: number;
    sort?: "-createdAt" | "createdAt";
}

export interface PageOptions extends CollectionOptions {
    page?: number;
}

export interface SheetPage {
    data: Sheet[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    links: { self: string; next: string | null; previous: string | null };
    meta: { fetchedAt: string };
}

export interface SheetCollection {
    data: Sheet[];
    meta: { total: number; pages: number; complete: true; fetchedAt: string };
}

export class MyMusic5Error extends Error {
    constructor(code: string, message: string, options?: { status?: number; retryAfter?: number; cause?: unknown });
    readonly code: string;
    readonly status: number;
    readonly retryAfter?: number;
}

export class MyMusic5Client {
    constructor(options?: ClientOptions);
    readonly sheets: {
        get(sheetId: number | string, options?: RequestOptions): Promise<Sheet>;
    };
    readonly artists: {
        listSheets(artistUrl: string, options?: PageOptions): Promise<SheetPage>;
        iterateSheetPages(artistUrl: string, options?: CollectionOptions): AsyncGenerator<SheetPage>;
        iterateSheets(artistUrl: string, options?: CollectionOptions): AsyncGenerator<Sheet>;
        collectSheets(artistUrl: string, options?: CollectionOptions): Promise<SheetCollection>;
    };
}
