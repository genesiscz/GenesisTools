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
import { createQaStream } from "@/transport/qa-stream";
import { streamSse as defaultStreamSse, type SseEvent } from "@/transport/sse-parser";
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

        const env = decodeEnvelope(await res.text());
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
        const path = url.replace(opts.relayBaseUrl, "");
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

    function client(): DashboardClient {
        return createDashboardClient({ baseUrl: opts.relayBaseUrl, fetch: encryptingFetch, authHeader: () => undefined });
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
            // Each relayed SSE `data:` line is an E2eEnvelope. The decrypting streamSse opens each
            // envelope to the plaintext QaRow JSON and re-emits it as a normal SseEvent, so the
            // QaStream's own parser/dedupe is unchanged. Mirror of wrapTerminalE2e on send.
            const decryptingStreamSse: typeof defaultStreamSse = (sseOpts) =>
                defaultStreamSse({
                    ...sseOpts,
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
                                sseOpts.onEvent({ ...event, data: new TextDecoder().decode(plain) });
                            }
                        } catch {
                            // drop a frame that isn't a valid envelope (keep-alive / handshake noise)
                        }
                    },
                });

            return createQaStream({
                baseUrl: opts.relayBaseUrl,
                authHeader: () => undefined,
                streamSseImpl: decryptingStreamSse,
            });
        },
        openTerminal(sessionId: string): TerminalTransport {
            // ttyd frames are E2E-wrapped at the relay; the renderer sends/receives plaintext via a
            // decrypting message adapter. partysocket carries ciphertext envelopes; we seal on send
            // and open on message.
            const wsUrl = `${opts.relayBaseUrl.replace(/^http/, "ws")}/ttyd/${sessionId}/ws`;
            const inner = createTerminalTransport({ wsUrl });
            return wrapTerminalE2e(inner, opts);
        },
    };
}

/** Wraps a TerminalTransport so send() seals and onMessage() opens E2eEnvelopes. */
function wrapTerminalE2e(inner: TerminalTransport, opts: E2eTransportOptions): TerminalTransport {
    return {
        get status() {
            return inner.status;
        },
        send(data) {
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
            const nonce = opts.cipher.randomNonce();
            const ct = opts.cipher.seal({
                plaintext: bytes,
                nonce,
                recipientPublicKey: opts.agentPublicKey,
                senderSecretKey: opts.deviceKeys.secretKey,
            });
            inner.send(
                encodeEnvelope({ v: 1, epk: toBase64(opts.deviceKeys.publicKey), n: toBase64(nonce), ct: toBase64(ct) }),
            );
        },
        onMessage(handler) {
            inner.onMessage((raw) => {
                try {
                    const env = decodeEnvelope(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
                    const plain = opts.cipher.open({
                        ciphertext: fromBase64(env.ct),
                        nonce: fromBase64(env.n),
                        senderPublicKey: opts.agentPublicKey,
                        recipientSecretKey: opts.deviceKeys.secretKey,
                    });

                    if (plain) {
                        handler(new TextDecoder().decode(plain));
                    }
                } catch {
                    // drop a frame that isn't a valid envelope (keep-alive / handshake noise)
                }
            });
        },
        onStatus: (handler) => inner.onStatus(handler),
        close: () => inner.close(),
    };
}
