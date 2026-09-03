/**
 * Reads a response body up to `maxBytes`. The `content-length` guard alone is
 * not enough: a chunked response declares no length, so `Number("")` is 0 and
 * an unbounded `response.text()` buffers whatever the endpoint sends. The
 * scheduler polls forever, so that is a repeated memory spike, not a one-off.
 */
export async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const declared = Number(response.headers.get("content-length") ?? "");

    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();

        return { text: "", truncated: true };
    }

    if (!response.body) {
        return { text: await response.text(), truncated: false };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    while (true) {
        const { value, done } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > maxBytes) {
            chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
            truncated = true;
            await reader.cancel();
            break;
        }

        chunks.push(value);
    }

    return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}
