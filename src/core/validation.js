import { invalid } from "./errors.js";

export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw invalid(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
}

export function sheetId(value) {
    if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
    return integer(value, "sheetId");
}

export function artistUrl(value) {
    if (typeof value !== "string" || !value.length || value.length > 200
        || /[\s\p{Cc}/\\?#%]/u.test(value) || value === "." || value === "..") {
        throw invalid("artistUrl must be a nonempty artist handle without path separators or whitespace.");
    }
    return value;
}

export function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
