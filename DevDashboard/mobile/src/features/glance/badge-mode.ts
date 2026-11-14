import { create } from "zustand";
import type { IconBadgeMode } from "@/features/glance/queries";
import { getPref, setPref } from "@/lib/storage/kv";

/** A stored `dd.iconBadge` value as a mode: anything but `off` (missing, unknown, corrupt) is the default. */
export function iconBadgeModeOf(saved: unknown): IconBadgeMode {
    return saved === "off" ? "off" : "waiting";
}

interface IconBadgeState {
    /** Null until the saved setting is read: the badge is never written before the app knows whether it is off. */
    mode: IconBadgeMode | null;
    load: () => Promise<void>;
    /** The Notifications screen's switch: the badge follows at once, and the choice is saved for the next start. */
    choose: (mode: IconBadgeMode) => Promise<void>;
}

/** The icon badge setting (F18), shared by the badge writer and the Notifications screen. */
export const useIconBadgeStore = create<IconBadgeState>((set, get) => ({
    mode: null,
    load: async () => {
        if (get().mode !== null) {
            return;
        }

        let saved: unknown = null;

        try {
            saved = await getPref("dd.iconBadge");
        } catch (err) {
            console.warn("[glance] icon badge setting unreadable; using the default", err);
        }

        // A choice made while the read ran wins over the stored value.
        if (get().mode === null) {
            set({ mode: iconBadgeModeOf(saved) });
        }
    },
    choose: async (mode) => {
        set({ mode });
        await setPref("dd.iconBadge", mode);
    },
}));
