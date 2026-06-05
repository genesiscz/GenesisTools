import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

// Agent-side pairing: re-export the PURE codec from the contract (the source of truth
// for the `devdashboard://pair?…` wire shape) and add ONLY the disk-touching persistence
// (node:os/Bun) that must NOT live in the RN-safe contract. No duplicate codec here.

export {
    buildPairingPayload,
    type PairingPayload,
    type PairingTier,
    parsePairingPayload,
} from "@app/dev-dashboard/contract/pairing";

export interface PersistedTunnelConfig {
    tunnelName: string;
    tunnelId: string;
    hostname: string;
    localPort: number;
    /** The pairing URI emitted for the mobile app (so a re-run can reprint the QR). */
    pairingUri?: string;
}

const TUNNEL_CONFIG_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "tunnel.json");

export function tunnelConfigPath(): string {
    return TUNNEL_CONFIG_PATH;
}

export async function persistTunnelConfig(config: PersistedTunnelConfig): Promise<void> {
    await Bun.write(TUNNEL_CONFIG_PATH, SafeJSON.stringify(config, null, 2));
    chmodSync(TUNNEL_CONFIG_PATH, 0o600);
    logger.info(
        { path: TUNNEL_CONFIG_PATH, tunnel: config.tunnelName },
        "dev-dashboard: tunnel config persisted (0600)"
    );
}

export async function loadTunnelConfig(): Promise<PersistedTunnelConfig | null> {
    const file = Bun.file(TUNNEL_CONFIG_PATH);

    if (!(await file.exists())) {
        return null;
    }

    return SafeJSON.parse(await file.text(), { strict: true }) as PersistedTunnelConfig;
}

/** Persist the built pairing payload alongside the tunnel config (convenience for the wizard). */
export async function persistPairing(
    config: Omit<PersistedTunnelConfig, "pairingUri">,
    pairingUri: string
): Promise<void> {
    await persistTunnelConfig({ ...config, pairingUri });
}
