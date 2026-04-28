import type { EngineEvent, Finding } from "@app/doctor/lib/types";
import type { StageItem } from "@app/utils/prompts/clack/trash-staging";
import { createStore } from "zustand/vanilla";

export type EnginePhase = "scanning" | "done" | "acting" | "exiting";

export interface EngineState {
    phase: EnginePhase;
    events: EngineEvent[];
    findingsById: Map<string, Finding>;
    focusedAnalyzerId: string;
    drawerOpen: boolean;
    selectedFindingIds: Set<string>;
    stagedItems: StageItem[];
    applyEvent(event: EngineEvent): void;
    toggleFinding(id: string): void;
    setFocused(id: string): void;
    setDrawer(open: boolean): void;
    setPhase(phase: EnginePhase): void;
    addStaged(items: StageItem[]): void;
    clearStaged(): void;
    clearSelection(): void;
    reset(focusedAnalyzerId: string): void;
}

function initialState(
    focusedAnalyzerId = ""
): Omit<
    EngineState,
    | "applyEvent"
    | "toggleFinding"
    | "setFocused"
    | "setDrawer"
    | "setPhase"
    | "addStaged"
    | "clearStaged"
    | "clearSelection"
    | "reset"
> {
    return {
        phase: "scanning",
        events: [],
        findingsById: new Map(),
        focusedAnalyzerId,
        drawerOpen: false,
        selectedFindingIds: new Set(),
        stagedItems: [],
    };
}

export const useEngineStore = createStore<EngineState>()((set) => ({
    ...initialState(),
    applyEvent: (event) =>
        set((state) => {
            const events = [...state.events, event];

            if (event.type === "finding") {
                const findingsById = new Map(state.findingsById);
                findingsById.set(event.finding.id, event.finding);
                return { events, findingsById };
            }

            if (event.type === "all-done") {
                return { events, phase: "done" };
            }

            return { events };
        }),
    toggleFinding: (id) =>
        set((state) => {
            const selectedFindingIds = new Set(state.selectedFindingIds);

            if (selectedFindingIds.has(id)) {
                selectedFindingIds.delete(id);
            } else {
                selectedFindingIds.add(id);
            }

            return { selectedFindingIds };
        }),
    setFocused: (focusedAnalyzerId) => set({ focusedAnalyzerId }),
    setDrawer: (drawerOpen) => set({ drawerOpen }),
    setPhase: (phase) => set({ phase }),
    addStaged: (items) => set((state) => ({ stagedItems: [...state.stagedItems, ...items] })),
    clearStaged: () => set({ stagedItems: [] }),
    clearSelection: () => set({ selectedFindingIds: new Set() }),
    reset: (focusedAnalyzerId) => set(initialState(focusedAnalyzerId)),
}));

export const engineStore = useEngineStore;
