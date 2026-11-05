import type { WakeRelayDto } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";

export interface RelayStorage {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

export interface RelayStore {
    load(connectionId: string): Promise<WakeRelayDto | null>;
    save(connectionId: string, relay: WakeRelayDto): Promise<void>;
}

/**
 * The last relay the Mac described, kept in the keychain (it holds the relay password): the Wake button has to work
 * while the Mac sleeps and answers nothing.
 */
function relayKey(connectionId: string): string {
    const encoded = connectionId
        .split("")
        .map((unit) => unit.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("");
    return `dd_wake_relay_${encoded}`;
}

/** The legacy unowned dd_wake_relay record is deliberately never read. */
export function createRelayStore(storage: RelayStorage): RelayStore {
    return {
        async save(connectionId, relay) {
            await storage.setItemAsync(relayKey(connectionId), SafeJSON.stringify(relay));
        },
        async load(connectionId) {
            const raw = await storage.getItemAsync(relayKey(connectionId));

            if (!raw) {
                return null;
            }

            const parsed: unknown = SafeJSON.parse(raw, { strict: true });
            return typeof parsed === "object" && parsed !== null && "configured" in parsed
                ? (parsed as WakeRelayDto)
                : null;
        },
    };
}
