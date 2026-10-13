import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";

const prof = profiler.scope("chrome-devtools");

export interface NetworkConditions {
    offline: boolean;
    /** Added round-trip latency in ms. */
    latencyMs: number;
    /** Download throughput in kbit/s; -1 = no limit. */
    downloadKbps: number;
    /** Upload throughput in kbit/s; -1 = no limit. */
    uploadKbps: number;
}

/** The DevTools Network panel presets (same throughput and latency factors). */
export const NETWORK_PRESETS = {
    none: { offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
    "3g": { offline: false, latencyMs: 2000, downloadKbps: 400, uploadKbps: 400 },
    "slow-4g": { offline: false, latencyMs: 562.5, downloadKbps: 1440, uploadKbps: 675 },
    "fast-4g": { offline: false, latencyMs: 165, downloadKbps: 8100, uploadKbps: 1350 },
    offline: { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
} as const satisfies Record<string, NetworkConditions>;

export type NetworkPreset = keyof typeof NETWORK_PRESETS;

export const NETWORK_PRESET_NAMES = Object.keys(NETWORK_PRESETS) as NetworkPreset[];

export function isNetworkPreset(value: string): value is NetworkPreset {
    return value in NETWORK_PRESETS;
}

/**
 * Slows the page's main thread by `rate` (1 = off, 4 = DevTools "4x slowdown").
 * The override belongs to this CDP session and ends when it detaches.
 */
export async function setCpuThrottle(cdp: CdpLike, rate: number): Promise<void> {
    const stopProfile = prof.start("emulate.cpu");
    try {
        if (!Number.isFinite(rate) || rate < 1) {
            throw new Error(`CPU throttling rate must be 1 or more, got ${rate}`);
        }

        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    } finally {
        stopProfile();
    }
}

/** Applies network conditions (a preset name or explicit values). Ends when the CDP session detaches. */
export async function setNetwork(
    cdp: CdpLike,
    conditions: NetworkPreset | NetworkConditions
): Promise<NetworkConditions> {
    const stopProfile = prof.start("emulate.network");
    try {
        const resolved = typeof conditions === "string" ? NETWORK_PRESETS[conditions] : conditions;
        const bytesPerSecond = (kbps: number): number => (kbps < 0 ? -1 : (kbps * 1000) / 8);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
            offline: resolved.offline,
            latency: resolved.latencyMs,
            downloadThroughput: bytesPerSecond(resolved.downloadKbps),
            uploadThroughput: bytesPerSecond(resolved.uploadKbps),
        });
        return resolved;
    } finally {
        stopProfile();
    }
}

/** CPU back to 1x and no network shaping. */
export async function resetEmulation(cdp: CdpLike): Promise<void> {
    await setCpuThrottle(cdp, 1);
    await setNetwork(cdp, "none");
}
