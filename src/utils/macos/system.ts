import { getDarwinKit } from "./darwinkit";
import type { CapabilitiesResult } from "./types";

/**
 * Get DarwinKit system capabilities — version, OS, architecture, available methods.
 */
export async function getCapabilities(): Promise<CapabilitiesResult> {
    return getDarwinKit().system.capabilities();
}
