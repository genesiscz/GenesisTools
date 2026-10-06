import {
    createDashboardClient,
    decodeEnvelope,
    decodeE2eResponse,
    encodeEnvelope,
    encodeE2eRequest,
    type BoxCipher,
    type DashboardClient,
    type E2eRequest,
    type KeyPair,
} from "@dd/contract";
import { fromBase64, toBase64 } from "@/transport/e2e/box-cipher";
import { createReconnectingEventSource } from "@/transport/event-source";
import { createQaStream } from "@/transport/qa-stream";
import {
    streamSse as defaultStreamSse,
    type SseEvent,
    type StreamSseOptions,
} from "@/transport/sse-parser";
import { createTerminalTransport } from "@/transport/terminal-ws";
import type { QaStream, TerminalTransport, Transport } from "@/transport/Transport";

const RPC_PATH = "/api/e2e/rpc";

export interface E2eTransportOptions {
    /** The vendor relay base URL for this paired Agent (opaque to the vendor). */
    relayBaseUrl: string;
    cipher: BoxCipher;
    deviceKeys: KeyPair;
    agentPublicKey: Uint8Array;
    /** expo/fetch by default; tests inject a loopback to the Agent shim. */
    fetchImpl?: typeof fetch;
    probe?: () => Promise<boolean>;
    /** Encrypted relay stream seam for tests and platform adapters. */
    streamSseImpl?: (options: StreamSseOptions) => { close(): void };
    sseRetryMs?: number;
}

export function createE2eTransport(opts: E2eTransportOptions): Transport {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

    /** Seal an inner-request envelope; POST to the relay's RPC endpoint; open the response envelope. */
    async function encryptedExchange(plaintext: Uint8Array): Promise<Uint8Array> {
        const nonce = opts.cipher.randomNonce();
        const ct = opts.cipher.seal({
            plaintext,
            nonce,
            recipientPublicKey: opts.agentPublicKey,
            senderSecretKey: opts.deviceKeys.secretKey,
        });
        const reqEnvelope = encodeEnvelope({
            v: 1,
            epk: toBase64(opts.deviceKeys.publicKey),
            n: toBase64(nonce),
            ct: toBase64(ct),
        });

        const res = await fetchImpl(`${opts.relayBaseUrl}${RPC_PATH}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-dd-e2e": "1" },
            body: reqEnvelope,
        });

        const raw = await res.text();

        // Check the status BEFORE decoding. A relay outage answers with an HTML or plain-text body,
        // and feeding that to decodeEnvelope threw a JSON syntax error that hid the status entirely —
        // `reachable()`'s catch then turned every outage into a bare false with no reason logged.
        if (!res.ok) {
            throw new Error(`e2e: relay returned HTTP ${res.status}: ${raw.slice(0, 200)}`);
        }

        const env = decodeEnvelope(raw);
        const plain = opts.cipher.open({
            ciphertext: fromBase64(env.ct),
            nonce: fromBase64(env.n),
            senderPublicKey: opts.agentPublicKey,
            recipientSecretKey: opts.deviceKeys.secretKey,
        });

        if (!plain) {
            throw new Error("e2e: response decryption failed");
        }

        return plain;
    }

    /** A `fetch`-shaped wrapper the contract client uses, but every byte is E2E-encrypted. */
    const encryptingFetch = (async (url: string, init?: RequestInit): Promise<Response> => {
        // Prefix-strip, not `String.replace`: replace substitutes the FIRST occurrence anywhere, so a
        // query value repeating the relay base (a callback or redirect parameter) was cut mid-query
        // and the agent received a mangled path.
        const path = url.startsWith(opts.relayBaseUrl) ? url.slice(opts.relayBaseUrl.length) : url;
        const request: E2eRequest = {
            method: init?.method ?? "GET",
            path,
            body: init?.body ? String(init.body) : undefined,
        };
        const plain = await encryptedExchange(new TextEncoder().encode(encodeE2eRequest(request)));
        const response = decodeE2eResponse(new TextDecoder().decode(plain));

        return new Response(response.body, {
            status: response.status,
            headers: { "Content-Type": response.contentType ?? "application/json" },
        });
    }) as unknown as typeof fetch;

    const decryptingStreamSse: typeof defaultStreamSse = (sseOptions) =>
        (opts.streamSseImpl ?? defaultStreamSse)({
            ...sseOptions,
            onEvent: (event: SseEvent) => {
                try {
                    const env = decodeEnvelope(event.data);
                    const plain = opts.cipher.open({
                        ciphertext: fromBase64(env.ct),
                        nonce: fromBase64(env.n),
                        senderPublicKey: opts.agentPublicKey,
                        recipientSecretKey: opts.deviceKeys.secretKey,
                    });

                    if (plain) {
                        sseOptions.onEvent({ ...event, data: new TextDecoder().decode(plain) });
                    }
                } catch {
                    // A relay frame that is not a valid encrypted envelope is never exposed to UI.
                }
            },
        });

    function client(): DashboardClient {
        return createDashboardClient({
            baseUrl: opts.relayBaseUrl,
            fetch: encryptingFetch,
            authHeader: () => undefined,
            eventSourceFactory: (url) =>
                createReconnectingEventSource({
                    url,
                    stream: decryptingStreamSse,
                    initialRetryMs: opts.sseRetryMs,
                    maxRetryMs: opts.sseRetryMs,
                }),
        });
    }

    return {
        tier: "managed",
        baseUrl: () => opts.relayBaseUrl,
        authHeader: () => undefined,
        reachable:
            opts.probe ??
            (async () => {
                try {
                    const probeRequest: E2eRequest = { method: "GET", path: "/api/system/pulse" };
                    await encryptedExchange(new TextEncoder().encode(encodeE2eRequest(probeRequest)));
                    return true;
                } catch {
                    return false;
                }
            }),
        client,
        streamQa(): QaStream {
            return createQaStream({
                baseUrl: opts.relayBaseUrl,
                authHeader: () => undefined,
                streamSseImpl: decryptingStreamSse,
            });
        },
        openTerminal(sessionId: string, dimensions): TerminalTransport {
            // Encrypt complete ttyd protocol frames so the relay sees only envelopes while the
            // agent receives valid init/input/resize bytes after decryption.
            const wsUrl = `${opts.relayBaseUrl.replace(/^http/, "ws")}/ttyd/${sessionId}/ws`;
            return createTerminalTransport({
                wsUrl,
                dimensions,
                wire: {
                    encode(frame) {
                        const nonce = opts.cipher.randomNonce();
                        const ct = opts.cipher.seal({
                            plaintext: new Uint8Array(frame),
                            nonce,
                            recipientPublicKey: opts.agentPublicKey,
                            senderSecretKey: opts.deviceKeys.secretKey,
                        });
                        return encodeEnvelope({
                            v: 1,
                            epk: toBase64(opts.deviceKeys.publicKey),
                            n: toBase64(nonce),
                            ct: toBase64(ct),
                        });
                    },
                    decode(frame) {
                        try {
                            const env = decodeEnvelope(
                                typeof frame === "string" ? frame : new TextDecoder().decode(frame)
                            );
                            const plain = opts.cipher.open({
                                ciphertext: fromBase64(env.ct),
                                nonce: fromBase64(env.n),
                                senderPublicKey: opts.agentPublicKey,
                                recipientSecretKey: opts.deviceKeys.secretKey,
                            });
                            return plain ? (new Uint8Array(plain).buffer as ArrayBuffer) : null;
                        } catch {
                            return null;
                        }
                    },
                },
            });
        },
    };
}
