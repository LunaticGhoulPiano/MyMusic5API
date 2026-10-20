export class MyMusic5Error extends Error {
    constructor(code, message, { status = 502, retryAfter, cause } = {}) {
        super(message, { cause });
        this.name = "MyMusic5Error";
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

export function invalid(message) {
    return new MyMusic5Error("INVALID_ARGUMENT", message, { status: 400 });
}

export function upstream(message) {
    return new MyMusic5Error("INVALID_UPSTREAM_RESPONSE", message);
}

export function cancelled() {
    return new MyMusic5Error("REQUEST_ABORTED", "The request was cancelled.", { status: 408 });
}

export function assertActive(signal) {
    if (signal?.aborted) throw cancelled();
}
