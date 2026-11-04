import type { WakeRelayDto } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
import * as SecureStore from "expo-secure-store";

/**
 * The last relay the Mac described, kept in the keychain (it holds the relay password): the Wake button has to work
 * while the Mac sleeps and answers nothing.
 */
const ITEM = "dd_wake_relay";

export async function saveRelay(relay: WakeRelayDto): Promise<void> {
    await SecureStore.setItemAsync(ITEM, SafeJSON.stringify(relay));
}

export async function loadRelay(): Promise<WakeRelayDto | null> {
    const raw = await SecureStore.getItemAsync(ITEM);

    if (!raw) {
        return null;
    }

    const parsed: unknown = SafeJSON.parse(raw, { strict: true });
    return typeof parsed === "object" && parsed !== null && "configured" in parsed ? (parsed as WakeRelayDto) : null;
}
