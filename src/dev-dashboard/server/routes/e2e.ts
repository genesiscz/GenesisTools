import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyAndConsumePairingCode } from "@app/dev-dashboard/lib/e2e/pairing-code";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

// The managed-tier pairing store. Holds device PUBLIC keys ONLY (0600 file) — there is
// nothing here the vendor relay could misuse even if it logged the pairing POST, because
// a public key is public by definition. The matching secret key never leaves the phone.
const PEERS_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "e2e-peers.json");

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
    await Bun.write(PEERS_PATH, SafeJSON.stringify(peers, null, 2));
    chmodSync(PEERS_PATH, 0o600);
    logger.info(
        { path: PEERS_PATH, peers: Object.keys(peers).length },
        "dev-dashboard: paired E2E device (public key stored)"
    );
}

export function e2eRoutes(): RouteDef[] {
    return [
        {
            method: "POST",
            pattern: "/api/e2e/pair",
            handler: async (ctx) => {
                try {
                    const body = await ctx.readJson<{ publicKey?: string; deviceCode?: string }>();

                    if (!body.publicKey || !body.deviceCode) {
                        return { kind: "json", status: 400, body: { error: "publicKey and deviceCode required" } };
                    }

                    // ADMISSION GATE: only a device presenting the short-lived, one-time code shown on
                    // the Mac (out-of-band) may be paired. Without this, anyone reaching the Agent —
                    // including the untrusted vendor relay — could self-pair and break the no-see claim.
                    if (!(await verifyAndConsumePairingCode(body.deviceCode))) {
                        logger.warn("dev-dashboard: e2e pair rejected — invalid or expired device code");
                        return { kind: "json", status: 403, body: { error: "invalid or expired pairing code" } };
                    }

                    await addPeer(body.publicKey);

                    return { kind: "json", status: 200, body: { ok: true } };
                } catch (err) {
                    logger.warn({ err }, "dev-dashboard: e2e pair request failed");
                    return errorResult(err);
                }
            },
        },
    ];
}
