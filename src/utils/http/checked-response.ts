import { REDIRECT_STATUSES } from "./redirect";

/** Follow a bounded redirect chain, validating each destination before sending a request there. */
export async function fetchWithCheckedRedirects({
    url,
    init,
    validate,
    maxRedirects = 5,
}: {
    url: string;
    init?: RequestInit;
    validate: (url: string) => void;
    maxRedirects?: number;
}): Promise<{ response: Response; url: string }> {
    let current = url;
    for (let hop = 0; ; hop++) {
        validate(current);
        const response = await fetch(current, { ...init, redirect: "manual" });
        if (!REDIRECT_STATUSES.has(response.status)) {
            return { response, url: response.url || current };
        }

        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop >= maxRedirects) {
            throw new Error("The remote response has an invalid or excessive redirect chain");
        }

        current = new URL(location, current).href;
    }
}

/** Decode at most maxBytes, cancelling the response as soon as its bound is reached. */
export async function readResponseTextBounded({
    response,
    maxBytes,
    truncate = false,
}: {
    response: Response;
    maxBytes: number;
    truncate?: boolean;
}): Promise<string> {
    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            const remaining = maxBytes - size;
            if (value.byteLength > remaining) {
                if (!truncate) {
                    throw new Error(`The remote response exceeds ${maxBytes} bytes`);
                }

                chunks.push(value.subarray(0, remaining));
                break;
            }

            chunks.push(value);
            size += value.byteLength;
            if (truncate && size === maxBytes) {
                break;
            }
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}
