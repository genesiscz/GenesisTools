import { runCmuxJSON, runCmuxOk } from "@app/cmux/lib/cli";
import { withFocusedWorkspace } from "@app/cmux/lib/focus-guard";
import { convergeToTarget, type ResizeTarget } from "@app/cmux/lib/resize";
import { paneList, type SurfaceSplitResult, surfaceCreate, workspaceCreate } from "@app/cmux/lib/socket";
import type { Pane, Profile, Surface, Workspace } from "@app/cmux/lib/types";
import logger from "@app/logger";

const EDGE_TOLERANCE_PX = 2;

export interface RestoreOptions {
    prefix: string;
    replay: boolean;
    yes: boolean;
    dryRun: boolean;
}

export interface RestorePlanWorkspace {
    sourceTitle: string;
    targetTitle: string;
    paneCount: number;
    surfaceCount: number;
}

export interface RestorePlan {
    workspaces: RestorePlanWorkspace[];
}

export interface RestoreOutcome {
    workspaces: Array<{
        ref: string;
        title: string;
        converged: boolean;
        iterations: number;
    }>;
}

export interface RestoreEvents {
    onWorkspaceStart?: (info: { title: string; index: number; total: number }) => void;
    onWorkspaceDone?: (info: { ref: string; title: string }) => void;
}

export function buildPlan(profile: Profile, opts: RestoreOptions): RestorePlan {
    const workspaces: RestorePlanWorkspace[] = [];
    for (const window of profile.windows) {
        for (const ws of window.workspaces) {
            const surfaceCount = ws.panes.reduce((acc, pane) => acc + pane.surfaces.length, 0);
            workspaces.push({
                sourceTitle: ws.title,
                targetTitle: `${opts.prefix}${ws.title}`,
                paneCount: ws.panes.length,
                surfaceCount,
            });
        }
    }
    return { workspaces };
}

export async function restoreProfile(
    profile: Profile,
    opts: RestoreOptions,
    events: RestoreEvents = {}
): Promise<RestoreOutcome> {
    const outcome: RestoreOutcome = { workspaces: [] };
    const totalWorkspaces = profile.windows.reduce((acc, w) => acc + w.workspaces.length, 0);
    let visited = 0;

    for (const window of profile.windows) {
        for (const ws of window.workspaces) {
            visited += 1;
            const targetTitle = `${opts.prefix}${ws.title}`;
            events.onWorkspaceStart?.({ title: targetTitle, index: visited, total: totalWorkspaces });

            const created = await workspaceCreate({ name: targetTitle });
            // workspace.create's name param is best-effort; cmux often overrides it with an
            // auto-generated user@host:cwd title. Force the desired title explicitly.
            try {
                await runCmuxOk(["rename-workspace", "--workspace", created.workspace_ref, targetTitle]);
            } catch (error) {
                logger.warn(
                    { error, workspaceRef: created.workspace_ref, targetTitle },
                    "[restore] rename-workspace failed; continuing with auto-generated title"
                );
            }
            const result = await withFocusedWorkspace(created.workspace_ref, async () => {
                return await materializeWorkspace(ws, created.workspace_ref, opts);
            });

            outcome.workspaces.push({
                ref: created.workspace_ref,
                title: targetTitle,
                converged: result.converged,
                iterations: result.iterations,
            });
            events.onWorkspaceDone?.({ ref: created.workspace_ref, title: targetTitle });
        }
    }
    return outcome;
}

interface MaterializeResult {
    converged: boolean;
    iterations: number;
}

async function materializeWorkspace(
    ws: Workspace,
    workspaceRef: string,
    opts: RestoreOptions
): Promise<MaterializeResult> {
    if (ws.panes.length === 0) {
        return { converged: true, iterations: 0 };
    }

    const initialLayout = await paneList(workspaceRef);
    if (initialLayout.panes.length !== 1) {
        throw new Error(`Expected new workspace to start with 1 pane, got ${initialLayout.panes.length}`);
    }
    const rootPane = initialLayout.panes[0];
    const rootSurface = rootPane.selected_surface_ref;

    const tree = buildSplitTree(ws.panes);
    const paneRefByIndex = new Map<number, string>();
    await applyTree(tree, rootSurface, workspaceRef, paneRefByIndex);

    // Map saved-pane ref → freshly-created pane ref (by saved index).
    const targets: ResizeTarget[] = [];
    for (const savedPane of ws.panes) {
        const newRef = paneRefByIndex.get(savedPane.index);
        if (!newRef) {
            logger.warn(
                { savedIndex: savedPane.index, mappedKeys: [...paneRefByIndex.keys()] },
                "[restore] saved pane index has no new pane mapping"
            );
            continue;
        }
        targets.push({ paneRef: newRef, columns: savedPane.columns, rows: savedPane.rows });
    }

    const convergence = await convergeToTarget(workspaceRef, targets);

    // Now populate surfaces per pane.
    for (const savedPane of ws.panes) {
        const paneRef = paneRefByIndex.get(savedPane.index);
        if (!paneRef) {
            continue;
        }
        await populatePane(savedPane, paneRef, workspaceRef, opts);
    }

    return { converged: convergence.converged, iterations: convergence.iterations };
}

export type SplitTree =
    | { kind: "leaf"; savedPaneIndex: number }
    | { kind: "vsplit"; left: SplitTree; right: SplitTree }
    | { kind: "hsplit"; top: SplitTree; bottom: SplitTree };

export interface RectPane {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export function buildSplitTree(panes: Pane[]): SplitTree {
    const rects: RectPane[] = panes.map((p) => ({
        index: p.index,
        x: p.pixel_frame.x,
        y: p.pixel_frame.y,
        width: p.pixel_frame.width,
        height: p.pixel_frame.height,
    }));
    return divideRects(rects);
}

function divideRects(rects: RectPane[]): SplitTree {
    if (rects.length === 1) {
        return { kind: "leaf", savedPaneIndex: rects[0].index };
    }

    const minX = Math.min(...rects.map((r) => r.x));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));

    // Try a vertical split — find an x that cleanly separates the rects.
    const candidateXs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.width]))]
        .filter((x) => x > minX + EDGE_TOLERANCE_PX && x < maxX - EDGE_TOLERANCE_PX)
        .sort((a, b) => a - b);
    for (const splitX of candidateXs) {
        const left = rects.filter((r) => r.x + r.width <= splitX + EDGE_TOLERANCE_PX);
        const right = rects.filter((r) => r.x >= splitX - EDGE_TOLERANCE_PX);
        if (left.length + right.length === rects.length && left.length > 0 && right.length > 0) {
            return {
                kind: "vsplit",
                left: divideRects(left),
                right: divideRects(right),
            };
        }
    }

    // Fall back to horizontal split.
    const candidateYs = [...new Set(rects.flatMap((r) => [r.y, r.y + r.height]))]
        .filter((y) => y > minY + EDGE_TOLERANCE_PX && y < maxY - EDGE_TOLERANCE_PX)
        .sort((a, b) => a - b);
    for (const splitY of candidateYs) {
        const top = rects.filter((r) => r.y + r.height <= splitY + EDGE_TOLERANCE_PX);
        const bottom = rects.filter((r) => r.y >= splitY - EDGE_TOLERANCE_PX);
        if (top.length + bottom.length === rects.length && top.length > 0 && bottom.length > 0) {
            return {
                kind: "hsplit",
                top: divideRects(top),
                bottom: divideRects(bottom),
            };
        }
    }

    throw new Error(
        `Pane layout is not representable as nested binary splits (${rects.length} rects). ` +
            "This usually means the saved layout was modified after capture."
    );
}

async function applyTree(
    tree: SplitTree,
    anchorSurface: string,
    workspaceRef: string,
    map: Map<number, string>
): Promise<void> {
    if (tree.kind === "leaf") {
        const layout = await paneList(workspaceRef);
        const pane = layout.panes.find((p) => p.surface_refs.includes(anchorSurface));
        if (!pane) {
            throw new Error(`Could not locate pane containing surface ${anchorSurface}`);
        }
        logger.debug({ anchor: anchorSurface, paneRef: pane.ref, savedIndex: tree.savedPaneIndex }, "[restore] leaf");
        map.set(tree.savedPaneIndex, pane.ref);
        return;
    }

    const direction = tree.kind === "vsplit" ? "right" : "down";
    const split = await splitFromSurface(direction, anchorSurface, workspaceRef);
    logger.debug(
        { direction, anchor: anchorSurface, newPane: split.pane_ref, newSurface: split.surface_ref },
        "[restore] split"
    );

    if (tree.kind === "vsplit") {
        await applyTree(tree.left, anchorSurface, workspaceRef, map);
        await applyTree(tree.right, split.surface_ref, workspaceRef, map);
        return;
    }

    await applyTree(tree.top, anchorSurface, workspaceRef, map);
    await applyTree(tree.bottom, split.surface_ref, workspaceRef, map);
}

async function populatePane(
    savedPane: Pane,
    paneRef: string,
    workspaceRef: string,
    opts: RestoreOptions
): Promise<void> {
    const expectedCount = savedPane.surfaces.length;
    if (expectedCount === 0) {
        return;
    }

    const currentLayout = await paneList(workspaceRef);
    const current = currentLayout.panes.find((p) => p.ref === paneRef);
    if (!current) {
        throw new Error(`Pane ${paneRef} disappeared mid-restore`);
    }
    const surfaceRefs = [...current.surface_refs];

    while (surfaceRefs.length < expectedCount) {
        const nextSavedSurface = savedPane.surfaces[surfaceRefs.length];
        const created = await surfaceCreate({
            workspace: workspaceRef,
            pane: paneRef,
            type: nextSavedSurface.type,
            url: nextSavedSurface.type === "browser" ? nextSavedSurface.url : undefined,
        });
        surfaceRefs.push(created.surface_ref);
    }

    // Rename + replay
    for (let i = 0; i < expectedCount; i += 1) {
        const savedSurface = savedPane.surfaces[i];
        const surfaceRef = surfaceRefs[i];
        if (savedSurface.title) {
            await runCmuxOk([
                "rename-tab",
                "--workspace",
                workspaceRef,
                "--surface",
                surfaceRef,
                savedSurface.title,
            ]).catch((error) => {
                logger.debug({ error, surfaceRef }, "[restore] rename-tab failed");
            });
        }
        if (savedSurface.type === "terminal") {
            await replayTerminal(savedSurface, workspaceRef, surfaceRef, opts);
        }
    }
}

async function splitFromSurface(
    direction: "right" | "down",
    surfaceRef: string,
    workspaceRef: string
): Promise<SurfaceSplitResult> {
    return runCmuxJSON<SurfaceSplitResult>([
        "new-split",
        direction,
        "--workspace",
        workspaceRef,
        "--surface",
        surfaceRef,
    ]);
}

function shellQuote(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
}

async function replayTerminal(
    surface: Surface & { type: "terminal" },
    workspaceRef: string,
    surfaceRef: string,
    opts: RestoreOptions
): Promise<void> {
    if (surface.cwd) {
        await runCmuxOk([
            "send",
            "--workspace",
            workspaceRef,
            "--surface",
            surfaceRef,
            `cd -- ${shellQuote(surface.cwd)}\n`,
        ]);
    }
    if (opts.replay && surface.command && surface.command_source !== "none") {
        // Send command WITHOUT a trailing newline so the user can confirm before executing.
        await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, surface.command]);
    }
}
