import { SafeJSON } from "@app/utils/json";
import type { TmuxHubSession } from "@/lib/api";

const TTYD_ACTIVE_KEY = "dd:view:ttyd:activeId";
const CMUX_ACTIVE_PANE_KEY = "dd:view:cmux:activePaneId";
const CMUX_SURFACES_KEY = "dd:view:cmux:surfaceByPane";

export function canRemoveFromCmux(session: Pick<TmuxHubSession, "cmuxSurfaces">): boolean {
    return session.cmuxSurfaces.length > 0;
}

function hasViewStorage(): boolean {
    return typeof localStorage !== "undefined";
}

export function readTtydActiveId(): string | null {
    if (!hasViewStorage()) {
        return null;
    }

    const value = localStorage.getItem(TTYD_ACTIVE_KEY);

    return value && value.length > 0 ? value : null;
}

export function writeTtydActiveId(id: string): void {
    if (!hasViewStorage()) {
        return;
    }

    localStorage.setItem(TTYD_ACTIVE_KEY, id);
}

export interface CmuxViewState {
    activePaneId: string | null;
    surfaceByPaneId: Record<string, string>;
}

export function readCmuxViewState(): CmuxViewState {
    if (!hasViewStorage()) {
        return { activePaneId: null, surfaceByPaneId: {} };
    }

    const activePaneId = localStorage.getItem(CMUX_ACTIVE_PANE_KEY);
    const raw = localStorage.getItem(CMUX_SURFACES_KEY);
    let surfaceByPaneId: Record<string, string> = {};

    if (raw) {
        try {
            const parsed = SafeJSON.parse(raw, { strict: true });

            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                surfaceByPaneId = parsed as Record<string, string>;
            }
        } catch {
            // ignore corrupt storage
        }
    }

    return {
        activePaneId: activePaneId && activePaneId.length > 0 ? activePaneId : null,
        surfaceByPaneId,
    };
}

export function writeCmuxViewState(state: CmuxViewState): void {
    if (!hasViewStorage()) {
        return;
    }

    if (state.activePaneId) {
        localStorage.setItem(CMUX_ACTIVE_PANE_KEY, state.activePaneId);
    } else {
        localStorage.removeItem(CMUX_ACTIVE_PANE_KEY);
    }

    if (Object.keys(state.surfaceByPaneId).length > 0) {
        localStorage.setItem(CMUX_SURFACES_KEY, SafeJSON.stringify(state.surfaceByPaneId));
    } else {
        localStorage.removeItem(CMUX_SURFACES_KEY);
    }
}

export function pickStoredTtydActiveId(sessionIds: string[]): string | null {
    const stored = readTtydActiveId();

    if (stored && sessionIds.includes(stored)) {
        return stored;
    }

    return null;
}

export function pickStoredCmuxActivePaneId(paneIds: string[]): string | null {
    const stored = readCmuxViewState().activePaneId;

    if (stored && paneIds.includes(stored)) {
        return stored;
    }

    return null;
}

export function mergeStoredCmuxSurfaceSelection(
    panes: Array<{ id: string; surfaces: Array<{ id: string }> }>
): Record<string, string> {
    const stored = readCmuxViewState().surfaceByPaneId;
    const next: Record<string, string> = {};

    for (const pane of panes) {
        const selectedSurfaceId = stored[pane.id];

        if (selectedSurfaceId && pane.surfaces.some((surface) => surface.id === selectedSurfaceId)) {
            next[pane.id] = selectedSurfaceId;
        }
    }

    return next;
}
