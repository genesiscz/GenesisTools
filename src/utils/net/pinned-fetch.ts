import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { resolvePublicOutboundTarget } from "./outbound-policy";

export interface PinnedRequestInput {
    url: URL;
    address: string;
    signal?: AbortSignal;
    headers?: HeadersInit;
}

export type PinnedRequest = (input: PinnedRequestInput) => Promise<Response>;

function nodePinnedRequest({ url, address, signal, headers }: PinnedRequestInput): Promise<Response> {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHeaders = new Headers(headers);
    requestHeaders.set("host", url.host);

    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                protocol: url.protocol,
                hostname: address,
                port: url.port || undefined,
                path: `${url.pathname}${url.search}`,
                method: "GET",
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

                resolve(
                    new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
                        status: incoming.statusCode ?? 500,
                        statusText: incoming.statusMessage,
                        headers: responseHeaders,
                    })
                );
            }
        );
        outgoing.once("error", reject);
        outgoing.end();
    });
}

export async function fetchPinnedPublicUrl({
    target,
    signal,
    headers,
    request = nodePinnedRequest,
}: {
    target: string;
    signal?: AbortSignal;
    headers?: HeadersInit;
    request?: PinnedRequest;
}): Promise<Response> {
    const { url, addresses } = await resolvePublicOutboundTarget(target);
    const address = addresses[0];
    if (!address) {
        throw new Error(`No public address available for ${url.hostname}`);
    }

    return request({ url, address, signal, headers });
}
