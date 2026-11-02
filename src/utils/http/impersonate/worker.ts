import { JSCallback, type Pointer, toArrayBuffer } from "bun:ffi";
import { CURLINFO, CURLOPT, type Libcurl, openLibcurl } from "./libcurl";
import type { FromWorker, ToWorker, WorkerInit, WorkerRequest } from "./protocol";

/**
 * The curl side of ImpersonatedHttpClient. One multi handle runs every transfer of one client; one share handle
 * keeps cookies, DNS and TLS sessions across them, like the cookie jar of a curl_cffi Session. curl_multi_poll
 * blocks this thread only; the client wakes it with curl_multi_wakeup when it posts a request.
 */

declare const self: Worker;

/** Bounds a poll when no socket and no curl timer is due, so a message missed by the wakeup still starts soon. */
const MAX_POLL_MS = 1000;
const MAX_REDIRECTS = 30;
/**
 * curl_cffi's default `accept_encoding`. It turns on curl's decoding; the impersonation keeps sending its own
 * Accept-Encoding header. Without it, some responses (Cloudflare's brotli 403 pages) arrive still compressed.
 */
const ACCEPT_ENCODING = "gzip, deflate, br";

interface Transfer {
    id: number;
    easy: Pointer;
    headerList: Pointer | null;
    body: Uint8Array[];
    /** Body bytes curl delivered, kept or not. */
    received: number;
    maxBodyBytes?: number;
    /** The body passed `maxBodyBytes` and the transfer was cut short. */
    overLimit: boolean;
    headers: Record<string, string>;
    callbacks: JSCallback[];
}

let curl: Libcurl;
let multi: Pointer;
let share: Pointer;
let config: WorkerInit;
const byEasy = new Map<number, Transfer>();
const byId = new Map<number, Transfer>();
let pumping = false;

function post(message: FromWorker, transfer: Transferable[] = []): void {
    self.postMessage(message, transfer);
}

/** `onChunk` returns false to refuse the chunk: the short count makes curl end the transfer (CURLE_WRITE_ERROR). */
function chunkCallback(onChunk: (bytes: Uint8Array) => boolean): JSCallback {
    return new JSCallback(
        (data: Pointer, size: bigint, count: bigint) => {
            const length = Number(size * count);
            if (length > 0 && !onChunk(new Uint8Array(toArrayBuffer(data, 0, length)).slice())) {
                return 0n;
            }

            return BigInt(length);
        },
        { args: ["ptr", "u64", "u64", "ptr"], returns: "u64" }
    );
}

function start(request: WorkerRequest): void {
    const easy = curl.easyInit();
    const transfer: Transfer = {
        id: request.id,
        easy,
        headerList: null,
        body: [],
        received: 0,
        maxBodyBytes: request.maxBodyBytes,
        overLimit: false,
        headers: {},
        callbacks: [],
    };
    const target = config.target;
    const impersonated = curl.impersonate(easy, target, true);
    if (impersonated !== 0) {
        curl.easyCleanup(easy);
        reply(transfer, 0, `libcurl-impersonate rejected target ${target}: ${curl.strerror(impersonated)}`);
        return;
    }

    const decoder = new TextDecoder("latin1");
    const onBody = chunkCallback((bytes) => {
        transfer.received += bytes.byteLength;
        if (transfer.maxBodyBytes !== undefined && transfer.received > transfer.maxBodyBytes) {
            transfer.overLimit = true;
            return false;
        }

        transfer.body.push(bytes);
        return true;
    });
    const onHeader = chunkCallback((bytes) => {
        const line = decoder.decode(bytes).trimEnd();
        if (line.startsWith("HTTP/")) {
            // A new status line starts a new response (a redirect hop or a proxy CONNECT): keep only the last.
            transfer.headers = {};
            return true;
        }

        const colon = line.indexOf(":");
        if (colon > 0) {
            // A repeated header (set-cookie) is joined with ", ", as curl_cffi's Headers.items() did.
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            const earlier = transfer.headers[name];
            transfer.headers[name] = earlier === undefined ? value : `${earlier}, ${value}`;
        }

        return true;
    });
    transfer.callbacks.push(onBody, onHeader);

    curl.setString(easy, CURLOPT.URL, request.url);
    curl.setString(easy, CURLOPT.CAINFO, config.caBundle);
    // The share handle holds the cookie jar (and turns the cookie engine on), so a cookie-free transfer stays out of
    // it, giving up the shared DNS and TLS session cache for this one transfer.
    if (!request.noCookies) {
        curl.setPointer(easy, CURLOPT.SHARE, share);
        curl.setString(easy, CURLOPT.COOKIEFILE, "");
    }

    curl.setString(easy, CURLOPT.ACCEPT_ENCODING, ACCEPT_ENCODING);
    curl.setLong(easy, CURLOPT.NOSIGNAL, 1);
    curl.setLong(easy, CURLOPT.FOLLOWLOCATION, request.followRedirects ? 1 : 0);
    curl.setLong(easy, CURLOPT.MAXREDIRS, MAX_REDIRECTS);
    curl.setLong(easy, CURLOPT.TIMEOUT_MS, request.timeoutMs);
    curl.setLong(easy, CURLOPT.CONNECTTIMEOUT_MS, request.timeoutMs);
    curl.setLong(easy, CURLOPT.LOW_SPEED_LIMIT, 1);
    curl.setLong(easy, CURLOPT.LOW_SPEED_TIME, Math.ceil(request.timeoutMs / 1000));
    curl.setPointer(easy, CURLOPT.WRITEFUNCTION, onBody.ptr);
    curl.setPointer(easy, CURLOPT.HEADERFUNCTION, onHeader.ptr);
    if (config.proxyUrl) {
        curl.setString(easy, CURLOPT.PROXY, config.proxyUrl);
        curl.setString(easy, CURLOPT.PROXY_CAINFO, config.caBundle);
        if (request.url.startsWith("https:")) {
            curl.setLong(easy, CURLOPT.HTTPPROXYTUNNEL, 1);
        }
    }

    const method = request.method.toUpperCase();
    if (method === "POST" || request.body !== undefined) {
        const body = Buffer.from(request.body ?? "", "utf8");
        if (method === "POST") {
            curl.setLong(easy, CURLOPT.POST, 1);
        }

        curl.setLong(easy, CURLOPT.POSTFIELDSIZE_LARGE, body.length);
        curl.setString(easy, CURLOPT.COPYPOSTFIELDS, body.toString("utf8"));
    }

    if (method !== "GET" && method !== "POST") {
        curl.setString(easy, CURLOPT.CUSTOMREQUEST, method);
    }

    // The impersonation's default headers stay; a line here replaces the default of the same name.
    for (const [name, value] of Object.entries(request.headers)) {
        transfer.headerList = curl.slistAppend(transfer.headerList, `${name}: ${value}`);
    }

    if (transfer.headerList) {
        curl.setPointer(easy, CURLOPT.HTTPHEADER, transfer.headerList);
    }

    byEasy.set(Number(easy), transfer);
    byId.set(request.id, transfer);
    curl.multiAdd(multi, easy);
}

function release(transfer: Transfer): void {
    byEasy.delete(Number(transfer.easy));
    byId.delete(transfer.id);
    curl.multiRemove(multi, transfer.easy);
    curl.easyCleanup(transfer.easy);
    curl.slistFree(transfer.headerList);
    for (const callback of transfer.callbacks) {
        callback.close();
    }
}

function reply(transfer: Transfer, status: number, error: string | null): void {
    const body = Buffer.concat(transfer.body);
    const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    post(
        {
            type: "reply",
            id: transfer.id,
            status,
            url: error ? "" : curl.infoString(transfer.easy, CURLINFO.EFFECTIVE_URL),
            headers: error ? {} : transfer.headers,
            body: error ? new ArrayBuffer(0) : buffer,
            error,
            overLimit: transfer.overLimit,
        },
        error ? [] : [buffer]
    );
}

function finish(easy: Pointer, result: number): void {
    const transfer = byEasy.get(Number(easy));
    if (!transfer) {
        return;
    }

    if (transfer.overLimit) {
        reply(transfer, 0, `the response body is larger than ${transfer.maxBodyBytes} bytes; the transfer was stopped`);
    } else if (result === 0) {
        reply(transfer, curl.infoLong(easy, CURLINFO.RESPONSE_CODE), null);
    } else {
        reply(transfer, 0, `curl: (${result}) ${curl.strerror(result)}`);
    }

    release(transfer);
}

async function pump(): Promise<void> {
    if (pumping) {
        return;
    }

    pumping = true;
    try {
        while (byEasy.size > 0) {
            curl.multiPerform(multi);
            for (const done of curl.multiDone(multi)) {
                finish(done.easy, done.result);
            }

            if (byEasy.size === 0) {
                break;
            }

            curl.multiPoll(multi, MAX_POLL_MS);
            // Let queued messages (new requests, aborts) in before the next round.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    } finally {
        pumping = false;
    }
}

function close(): void {
    for (const transfer of [...byEasy.values()]) {
        release(transfer);
    }

    curl.multiCleanup(multi);
    curl.shareCleanup(share);
    post({ type: "closed" });
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
    const message = event.data;
    try {
        switch (message.type) {
            case "init":
                config = message;
                curl = openLibcurl(message.library);
                multi = curl.multiInit();
                share = curl.shareInit();
                post({ type: "ready", multi: Number(multi) });
                return;
            case "request":
                start(message);
                void pump();
                return;
            case "abort": {
                const transfer = byId.get(message.id);
                if (transfer) {
                    release(transfer);
                }

                return;
            }
            case "close":
                close();
                return;
        }
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (message.type === "request") {
            post({
                type: "reply",
                id: message.id,
                status: 0,
                url: "",
                headers: {},
                body: new ArrayBuffer(0),
                error: text,
                overLimit: false,
            });
            return;
        }

        post({ type: "failed", error: text });
    }
};
