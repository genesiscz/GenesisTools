import { create } from "zustand";

/**
 * Cross-feature deep-link handoff. A terminal-kind attention item stashes its ttyd id here, then
 * navigates to the Terminals tab; that screen drains the pending id on focus and opens the session.
 * Feature-local on purpose (mirrors the terminals `driver-store` convention) — it carries one
 * transient id, not persisted state.
 */

interface AttentionTargetState {
    pendingTtydId: string | null;
    setPendingTtydId: (id: string | null) => void;
}

export const useAttentionTargetStore = create<AttentionTargetState>((set) => ({
    pendingTtydId: null,
    setPendingTtydId: (pendingTtydId) => set({ pendingTtydId }),
}));
