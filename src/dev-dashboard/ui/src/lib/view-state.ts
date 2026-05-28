import { SafeJSON } from "@app/utils/json";
import type { TmuxHubSession } from "@/lib/api";

export const TTYD_TAB_SEARCH_KEY = "tab";

const TTYD_ACTIVE_KEY = "dd:view:ttyd:activeId";
const CMUX_ACTIVE_PANE_KEY = "dd:view:cmux:activePaneId";
const CMUX_SURFACES_KEY = "dd:view:cmux:surfaceByPane";

export function canRemoveFromCmux(session: Pick<TmuxHubSession, "cmuxSurfaces">): boolean {
    return session.cmuxSurfaces.length > 0;
}

function hasLocalStorage(): boolean {
    return typeof localStorage !== "undefined";
}

function hasSessionStorage(): boolean {
    return typeof sessionStorage !== "undefined";
}

/** Per browser tab — windows can keep different active ttyd sessions. */
export function readTtydActiveId(): string | null {
    if (!hasSessionStorage()) {
        return null;
    }

    const value = sessionStorage.getItem(TTYD_ACTIVE_KEY);

    return value && value.length > 0 ? value : null;
}

export function writeTtydActiveId(id: string): void {
    if (!hasSessionStorage()) {
        return;
    }

    sessionStorage.setItem(TTYD_ACTIVE_KEY, id);
}

export function clearTtydActiveId(): void {
    if (!hasSessionStorage()) {
        return;
    }

    sessionStorage.removeItem(TTYD_ACTIVE_KEY);
}

export interface CmuxViewState {
    activePaneId: string | null;
    surfaceByPaneId: Record<string, string>;
}

export function readCmuxViewState(): CmuxViewState {
    if (!hasLocalStorage()) {
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
    if (!hasLocalStorage()) {
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

/** URL `?tab=` wins (shareable deep link), then per-tab sessionStorage, then first session. */
export function pickTtydActiveId({
    sessionIds,
    urlTabId,
}: {
    sessionIds: string[];
    urlTabId?: string | null;
}): string | null {
    if (urlTabId && sessionIds.includes(urlTabId)) {
        return urlTabId;
    }

    const stored = pickStoredTtydActiveId(sessionIds);

    if (stored) {
        return stored;
    }

    return sessionIds[0] ?? null;
}

export function ttydTabSearchHref(ttydId: string): string {
    return `/ttyd?${TTYD_TAB_SEARCH_KEY}=${encodeURIComponent(ttydId)}`;
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
