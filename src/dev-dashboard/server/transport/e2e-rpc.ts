import { decodeE2eRequest, type E2eResponse, encodeE2eResponse } from "@app/dev-dashboard/contract/e2e-request";
import type { BoxCipher, KeyPair } from "@app/dev-dashboard/lib/e2e/box";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import type { Router } from "@app/dev-dashboard/server/router";
import { createE2eShim } from "@app/dev-dashboard/server/transport/e2e-shim";
import type { RouteServices } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

// The managed-tier `POST /api/e2e/rpc` handler, extracted as a PURE function so it is
// unit-testable without binding a real port. serve.ts just calls it with live deps.
//
// FLOW: open the inbound E2eEnvelope (the shim verifies the epk is paired + the box MAC) ->
// decode the inner E2eRequest -> replay it through the real route registry via a synthetic
// Request -> seal the E2eResponse back. Crypto/pairing/envelope failures THROW (serve.ts maps
// them to a single generic 403 so nothing leaks which check failed — no decryption oracle). A
// successful-decrypt-but-no-route is NOT an error: it returns an ENCRYPTED E2eResponse{404}.

export interface E2eRpcDeps {
    cipher: BoxCipher;
    agentKeys: KeyPair;
    /**
     * SYNC peer-key resolver (the shim's contract). serve.ts snapshots `loadPeers()`
     * per request and closes over it; tests inject a fixed key. Returns the STORED key
     * bytes for a paired epk, or null for an unpaired one (the trust gate).
     */
    resolvePeerKey: (peerPublicKeyB64: string) => Uint8Array | null;
    router: Router;
    services: RouteServices;
}

const E2E_SYNTHETIC_ORIGIN = "http://e2e.local";

function isBodylessMethod(method: string): boolean {
    const m = method.toUpperCase();
    return m === "GET" || m === "HEAD";
}

/**
 * Decrypt + replay one E2E rpc envelope, returning the encrypted response envelope.
 * THROWS only on crypto/pairing/envelope failure (caller → generic 403). All HTTP-level
 * outcomes (404, 500 from a handler, etc.) come back as a normal encrypted E2eResponse.
 */
export async function handleE2eRpc(rawEnvelope: string, deps: E2eRpcDeps): Promise<string> {
    const shim = createE2eShim({
        cipher: deps.cipher,
        agentKeys: deps.agentKeys,
        resolvePeerKey: deps.resolvePeerKey,
        handle: async (plaintext): Promise<Uint8Array> => {
            const req = decodeE2eRequest(new TextDecoder().decode(plaintext));

            const init: RequestInit = { method: req.method };

            if (req.body !== undefined && !isBodylessMethod(req.method)) {
                init.body = req.body;
                init.headers = { "Content-Type": "application/json" };
            }

            const synthetic = new Request(`${E2E_SYNTHETIC_ORIGIN}${req.path}`, init);
            const res = await routerToResponse(deps.router, synthetic, { services: deps.services });

            if (!res) {
                const notFound: E2eResponse = {
                    status: 404,
                    body: SafeJSON.stringify({ error: "Not found" }),
                    contentType: "application/json",
                };
                return new TextEncoder().encode(encodeE2eResponse(notFound));
            }

            const contentType = res.headers.get("Content-Type") ?? "application/json";

            // SSE round-trips would hang `.text()` forever (the stream never closes). Streaming
            // over E2E rpc is out of scope here.
            // TODO(plan-02): streaming E2E (SSE / WS) over the managed tier.
            if (contentType.includes("text/event-stream")) {
                // Cancel the never-closing stream so the route's start()-allocated timers/subscriptions
                // get torn down (cancel() → the SSE handle's close()); otherwise a paired client could
                // spam an SSE path to leak resources.
                await res.body?.cancel();
                const notImpl: E2eResponse = {
                    status: 501,
                    body: SafeJSON.stringify({ error: "streaming not supported over E2E rpc" }),
                    contentType: "application/json",
                };
                return new TextEncoder().encode(encodeE2eResponse(notImpl));
            }

            const response: E2eResponse = {
                status: res.status,
                body: await res.text(),
                contentType,
            };
            return new TextEncoder().encode(encodeE2eResponse(response));
        },
    });

    return shim.handleEncrypted(rawEnvelope);
}
