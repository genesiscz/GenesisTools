import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Reader for cmux's own autosave file (`~/Library/Application Support/cmux/
 * session-<bundle>.json`). It is written by the app continuously and survives a
 * UI-thread livelock, which makes it the layout source of truth for offline
 * profile capture when the socket cannot answer.
 */

export interface AutosavePanel {
    id: string;
    stableSurfaceId?: string;
    type: string;
    title?: string;
    directory?: string;
    ttyName?: string;
    listeningPorts?: number[];
}

export interface AutosaveLayoutPaneNode {
    type: "pane";
    pane: { panelIds: string[]; selectedPanelId?: string };
}

export interface AutosaveLayoutSplitNode {
    type: "split";
    split: {
        orientation: "horizontal" | "vertical";
        /** Fraction (0..1) of the container given to `first`. */
        dividerPosition: number;
        first: AutosaveLayoutNode;
        second: AutosaveLayoutNode;
    };
}

export type AutosaveLayoutNode = AutosaveLayoutPaneNode | AutosaveLayoutSplitNode;

export interface AutosaveWorkspace {
    workspaceId?: string;
    stableId?: string;
    customTitle?: string;
    processTitle?: string;
    currentDirectory?: string;
    focusedPanelId?: string;
    layout: AutosaveLayoutNode;
    panels: AutosavePanel[];
}

export interface AutosaveWindow {
    frame?: { x: number; y: number; width: number; height: number };
    tabManager: { selectedWorkspaceIndex?: number; workspaces: AutosaveWorkspace[] };
}

export interface AutosaveSession {
    path: string;
    savedAtMs: number;
    windows: AutosaveWindow[];
}

export function autosaveDir(): string {
    return join(homedir(), "Library", "Application Support", "cmux");
}

export function listAutosaveFiles(
    dir: string = autosaveDir(),
    which: "current" | "previous"
): Array<{ path: string; mtimeMs: number }> {
    return readdirSync(dir)
        .filter((name) => name.startsWith("session-") && name.endsWith(".json"))
        .filter((name) => {
            const previous = name.endsWith("-previous.json");
            return which === "previous" ? previous : !previous;
        })
        .map((name) => {
            const path = join(dir, name);
            return { path, mtimeMs: statSync(path).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function readAutosaveFile(path: string, mtimeMs?: number): AutosaveSession {
    const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
    const savedAtMs = mtimeMs ?? statSync(path).mtimeMs;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        logger.warn({ path }, "[cmux-autosave] ignored non-object autosave");
        return { path, savedAtMs, windows: [] };
    }

    const windows = Array.isArray((raw as { windows?: unknown }).windows)
        ? (raw as { windows: AutosaveWindow[] }).windows
        : [];
    logger.debug({ path, windows: windows.length }, "[cmux-autosave] loaded");
    return { path, savedAtMs, windows };
}

/** Newest `session-*.json` in the autosave dir, parsed. Throws when none exists. */
export function readAutosaveSession(dir: string = autosaveDir()): AutosaveSession {
    const newest = listAutosaveFiles(dir, "current")[0];
    if (!newest) {
        throw new Error(`No cmux autosave session file found in ${dir}`);
    }

    return readAutosaveFile(newest.path, newest.mtimeMs);
}

/** The file cmux renamed aside on last launch (`*-previous.json`). */
export function readPreviousAutosaveSession(dir: string = autosaveDir()): AutosaveSession {
    const newest = listAutosaveFiles(dir, "previous")[0];
    if (!newest) {
        throw new Error(`No cmux previous-autosave file found in ${dir}`);
    }

    return readAutosaveFile(newest.path, newest.mtimeMs);
}

/** panel id (== live surface uuid == CMUX_SURFACE_ID) → panel, across all windows/workspaces. */
export function panelsById(session: AutosaveSession): Map<string, AutosavePanel> {
    const map = new Map<string, AutosavePanel>();
    for (const window of session.windows) {
        for (const ws of window.tabManager.workspaces) {
            for (const panel of ws.panels) {
                map.set(panel.id, panel);
                if (panel.stableSurfaceId) {
                    map.set(panel.stableSurfaceId, panel);
                }
            }
        }
    }

    return map;
}

export interface FlattenedPane {
    panelIds: string[];
    selectedPanelId?: string;
    frame: { x: number; y: number; width: number; height: number };
}

/**
 * Walk the autosave's binary split tree and assign each leaf pane a pixel frame
 * within the given container. `dividerPosition` is the fraction handed to the
 * `first` child; horizontal splits divide left/right, vertical top/bottom.
 */
export function flattenLayout(
    node: AutosaveLayoutNode,
    frame: { x: number; y: number; width: number; height: number }
): FlattenedPane[] {
    if (node.type === "pane") {
        return [{ panelIds: node.pane.panelIds, selectedPanelId: node.pane.selectedPanelId, frame }];
    }

    const { orientation, dividerPosition, first, second } = node.split;
    const fraction = Math.min(Math.max(dividerPosition, 0.05), 0.95);

    if (orientation === "horizontal") {
        const firstWidth = frame.width * fraction;
        return [
            ...flattenLayout(first, { ...frame, width: firstWidth }),
            ...flattenLayout(second, { ...frame, x: frame.x + firstWidth, width: frame.width - firstWidth }),
        ];
    }

    const firstHeight = frame.height * fraction;
    return [
        ...flattenLayout(first, { ...frame, height: firstHeight }),
        ...flattenLayout(second, { ...frame, y: frame.y + firstHeight, height: frame.height - firstHeight }),
    ];
}
