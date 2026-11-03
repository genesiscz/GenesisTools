import { decodeEnvelope } from "@app/dev-dashboard/contract/e2e-envelope";
import { decodeE2ePairAdmission } from "@app/dev-dashboard/contract/e2e-request";
import {
    type BoxCipher,
    fromBase64,
    type KeyPair,
    loadOrCreateAgentKeys,
    naclBoxCipher,
} from "@app/dev-dashboard/lib/e2e/box";
import { verifyAndConsumePairingCode } from "@app/dev-dashboard/lib/e2e/pairing-code";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

// The managed-tier pairing store. Holds device PUBLIC keys ONLY (0600 file) — there is
// nothing here the vendor relay could misuse even if it logged the pairing POST, because
// a public key is public by definition. The matching secret key never leaves the phone.
const PEERS_PATH = genesisToolsDir("dev-dashboard", "e2e-peers.json");

interface PeerRecord {
    publicKey: string;
    pairedAt: string;
}

export async function loadPeers(): Promise<Record<string, PeerRecord>> {
    const file = Bun.file(PEERS_PATH);

    if (!(await file.exists())) {
        return {};
    }

    return SafeJSON.parse(await file.text(), { strict: true }) as Record<string, PeerRecord>;
}

async function addPeer(publicKeyB64: string): Promise<void> {
    const peers = await loadPeers();
    peers[publicKeyB64] = { publicKey: publicKeyB64, pairedAt: new Date().toISOString() };
    atomicWriteFileSync(PEERS_PATH, SafeJSON.stringify(peers, null, 2), { mode: 0o600 });
    logger.info(
        { path: PEERS_PATH, peers: Object.keys(peers).length },
        "dev-dashboard: paired E2E device (public key stored)"
    );
}

export interface E2ePairDeps {
    cipher: BoxCipher;
    /** The Mac's keypair, whose public half the phone pinned from the pairing QR. */
    agentKeys: () => Promise<KeyPair>;
}

/** Opens a sealed admission; null when it is not sealed to this Mac by the key it names. */
function openAdmission(
    envelope: string,
    deps: { cipher: BoxCipher; agentKeys: KeyPair }
): { publicKey: string; deviceCode: string } | null {
    const env = decodeEnvelope(envelope);
    const plain = deps.cipher.open({
        ciphertext: fromBase64(env.ct),
        nonce: fromBase64(env.n),
        senderPublicKey: fromBase64(env.epk),
        recipientSecretKey: deps.agentKeys.secretKey,
    });

    return plain ? { publicKey: env.epk, ...decodeE2ePairAdmission(new TextDecoder().decode(plain)) } : null;
}

export function e2eRoutes(
    deps: E2ePairDeps = { cipher: naclBoxCipher, agentKeys: () => loadOrCreateAgentKeys() }
): RouteDef[] {
    return [
        {
            method: "POST",
            pattern: "/api/e2e/pair",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ envelope?: string }>();

                    if (typeof body.envelope !== "string" || body.envelope === "") {
                        return { kind: "json", status: 400, body: { error: "a sealed envelope is required" } };
                    }

                    // The code and the phone's key travel sealed to the Mac's QR-pinned key: the relay terminates
                    // TLS, so a plaintext code would let an active relay forward it with its own key instead.
                    let admission: { publicKey: string; deviceCode: string } | null;

                    try {
                        admission = openAdmission(body.envelope, {
                            cipher: deps.cipher,
                            agentKeys: await deps.agentKeys(),
                        });
                    } catch (err) {
                        logger.warn({ err }, "dev-dashboard: e2e pair rejected — malformed admission");
                        return { kind: "json", status: 400, body: { error: "malformed pairing request" } };
                    }

                    if (!admission) {
                        logger.warn("dev-dashboard: e2e pair rejected — not sealed to this Mac by the key it names");
                        return { kind: "json", status: 403, body: { error: "invalid or expired pairing code" } };
                    }

                    // ADMISSION GATE: only a device presenting the short-lived, one-time code shown on
                    // the Mac (out-of-band) may be paired. Without this, anyone reaching the Agent —
                    // including the untrusted vendor relay — could self-pair and break the no-see claim.
                    if (!(await verifyAndConsumePairingCode(admission.deviceCode))) {
                        logger.warn("dev-dashboard: e2e pair rejected — invalid or expired device code");
                        return { kind: "json", status: 403, body: { error: "invalid or expired pairing code" } };
                    }

                    await addPeer(admission.publicKey);

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    logger.warn({ err }, "dev-dashboard: e2e pair request failed");
                    return errorResult(err);
                }
            },
        },
    ];
}
