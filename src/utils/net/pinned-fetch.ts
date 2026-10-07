import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { resolvePublicOutboundTarget } from "./outbound-policy";

export interface PinnedRequestInput {
    url: URL;
    address: string;
    signal?: AbortSignal;
    headers?: HeadersInit;
    /** Defaults to GET. */
    method?: string;
    body?: string;
}

export type PinnedRequest = (input: PinnedRequestInput) => Promise<Response>;

/**
 * One HTTP(S) request sent to `address` while TLS and the Host header still name `url.hostname`,
 * so the connection reaches exactly the address that was checked, never a second DNS answer.
 * Redirects are not followed: a 3xx comes back as the response.
 */
export function pinnedRequest({ url, address, signal, headers, method, body }: PinnedRequestInput): Promise<Response> {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("host", url.host);
    if (body !== undefined) {
        requestHeaders.set("content-length", String(Buffer.byteLength(body)));
    }

    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                protocol: url.protocol,
                hostname: address,
                port: url.port || undefined,
                path: `${url.pathname}${url.search}`,
                method: method ?? "GET",
                headers: Object.fromEntries(requestHeaders.entries()),
                servername: url.hostname.replace(/^\[|\]$/g, ""),
                signal,
            },
            (incoming) => {
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            responseHeaders.append(name, item);
                        }
                    } else if (value !== undefined) {
                        responseHeaders.set(name, value);
                    }
                }

                const status = incoming.statusCode ?? 500;
                // The Response constructor throws on a null-body status given a body (204, 205, 304)
                // and on a status outside 200-599; a throw here would escape as an uncaught exception.
                const nullBody = status === 204 || status === 205 || status === 304;
                try {
                    if (status < 200 || status > 599) {
                        throw new Error(`Unsupported HTTP status ${status} from ${url.host}`);
                    }

                    if (nullBody) {
                        incoming.resume();
                    }

                    resolve(
                        new Response(
                            nullBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
                            { status, statusText: incoming.statusMessage, headers: responseHeaders }
                        )
                    );
                } catch (error) {
                    incoming.destroy();
                    reject(error);
                }
            }
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. DNS lookups take no signal, so
 * without this a stalled resolver outlives the caller's deadline. The lookup itself keeps running
 * in the background; only the wait on it ends.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        // The caller already gets the abort; the lookup's own outcome is no longer wanted, but its
        // rejection must still be observed, or it surfaces later as an unhandled rejection.
        promise.catch(() => undefined);
        return Promise.reject(signal.reason);
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}

export async function fetchPinnedPublicUrl({
    target,
    signal,
    headers,
    request = pinnedRequest,
}: {
    target: string;
    signal?: AbortSignal;
    headers?: HeadersInit;
    request?: PinnedRequest;
}): Promise<Response> {
    const { url, addresses } = await untilAborted(resolvePublicOutboundTarget(target), signal);
    const address = addresses[0];
    if (!address) {
        throw new Error(`No public address available for ${url.hostname}`);
    }

    signal?.throwIfAborted();
    return request({ url, address, signal, headers });
}
