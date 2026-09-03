import { create } from "zustand";
import { getPref, setPref, type TerminalDriverId } from "@/lib/storage/kv";

/**
 * Persisted active-driver state for the in-app driver switcher (D12). Feature-local on purpose:
 * the foundation already types the `dd.terminalDriver` pref in `src/lib/storage/kv.ts`, so this
 * store just bridges that persisted value into a reactive Zustand store the Terminal screen reads.
 * We CONSUME `getPref/setPref` + the `TerminalDriverId` union (no edit to the shared kv module).
 *
 * The union owns three ids; v1 registers the two WebView drivers and reserves `"native"` (the
 * SwiftTerm escape hatch, not built). The default is `"webview-ttyd"` (plan-06 Task 0 says the
 * device spike picks A-if-cookie-auth-holds-else-B; absent a device run here, A is the documented
 * default and the user can flip to B in-app — see the terminals notes).
 */

export const DEFAULT_DRIVER: TerminalDriverId = "webview-ttyd";

interface DriverState {
    driver: TerminalDriverId;
    hydrated: boolean;
    setDriver: (driver: TerminalDriverId) => void;
    hydrate: () => Promise<void>;
}

export const useDriverStore = create<DriverState>((set) => ({
    driver: DEFAULT_DRIVER,
    hydrated: false,
    setDriver: (driver) => {
        set({ driver });
        void setPref("dd.terminalDriver", driver);
    },
    hydrate: async () => {
        const stored = await getPref("dd.terminalDriver");
        set({ driver: stored ?? DEFAULT_DRIVER, hydrated: true });
    },
}));
