import { runCmuxJSON, runCmuxOk } from "@app/cmux/lib/cli";
import { withFocusedWorkspace } from "@app/cmux/lib/focus-guard";
import { paneList, type SurfaceSplitResult, workspaceCreate } from "@app/cmux/lib/socket";
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
        /** Largest |saved - actual| over all panes / dimensions, in terminal cells. */
        maxCellDelta: number;
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
                maxCellDelta: result.maxCellDelta,
            });
            events.onWorkspaceDone?.({ ref: created.workspace_ref, title: targetTitle });
        }
    }
    return outcome;
}

interface MaterializeResult {
    converged: boolean;
    /** Largest |saved - actual| over all panes / dimensions, in terminal cells. */
    maxCellDelta: number;
}

async function materializeWorkspace(
    ws: Workspace,
    workspaceRef: string,
    opts: RestoreOptions
): Promise<MaterializeResult> {
    if (ws.panes.length === 0) {
        return { converged: true, maxCellDelta: 0 };
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

    // applyTree resizes the new border immediately after each split, so by the time
    // the topology is fully built every saved fraction is already in place. Verify
    // and report any panes that ended up off (most likely cmux clamped a resize at
    // a minimum-pane-size limit).
    const finalLayout = await paneList(workspaceRef);
    let maxDelta = 0;
    for (const savedPane of ws.panes) {
        const newRef = paneRefByIndex.get(savedPane.index);
        if (!newRef) {
            logger.warn(
                { savedIndex: savedPane.index, mappedKeys: [...paneRefByIndex.keys()] },
                "[restore] saved pane index has no new pane mapping"
            );
            continue;
        }
        const live = finalLayout.panes.find((p) => p.ref === newRef);
        if (!live) {
            continue;
        }
        const dCols = Math.abs(savedPane.columns - live.columns);
        const dRows = Math.abs(savedPane.rows - live.rows);
        maxDelta = Math.max(maxDelta, dCols, dRows);
    }

    for (const savedPane of ws.panes) {
        const paneRef = paneRefByIndex.get(savedPane.index);
        if (!paneRef) {
            continue;
        }
        await populatePane(savedPane, paneRef, workspaceRef, opts);
    }

    return { converged: maxDelta <= 1, maxCellDelta: maxDelta };
}

export type SplitTree =
    | { kind: "leaf"; savedPaneIndex: number }
    | {
          kind: "vsplit";
          left: SplitTree;
          right: SplitTree;
          /** Saved fraction of the parent's width occupied by the left subtree (0..1). */
          leftFraction: number;
      }
    | {
          kind: "hsplit";
          top: SplitTree;
          bottom: SplitTree;
          /** Saved fraction of the parent's height occupied by the top subtree (0..1). */
          topFraction: number;
      };

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
                leftFraction: (splitX - minX) / (maxX - minX),
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
                topFraction: (splitY - minY) / (maxY - minY),
            };
        }
    }

    throw new Error(
        `Pane layout is not representable as nested binary splits (${rects.length} rects). ` +
            "This usually means the saved layout was modified after capture."
    );
}

/**
 * Walk the split tree and recreate the layout in cmux. After EACH split we resize the
 * just-created border to match the saved fraction — at that moment only two panes share
 * that border, so cmux's `resize-pane` can move it freely. This is critical because once
 * deeper splits exist, `pane.resize` rejects requests with "no adjacent border" for any
 * border that isn't directly between this pane and one sibling pane in the binary tree.
 *
 * Doing the resize at split time means we never need a global convergence loop afterward.
 */
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

    await resizeNewBorder(tree, anchorSurface, split.pane_ref, workspaceRef);

    if (tree.kind === "vsplit") {
        await applyTree(tree.left, anchorSurface, workspaceRef, map);
        await applyTree(tree.right, split.surface_ref, workspaceRef, map);
        return;
    }

    await applyTree(tree.top, anchorSurface, workspaceRef, map);
    await applyTree(tree.bottom, split.surface_ref, workspaceRef, map);
}

/**
 * Resize the brand-new border between `anchorSurface`'s pane and the just-split-off
 * `newPaneRef` until the saved fraction is reached (within 1 cell). cmux's `resize-pane`
 * `--amount` is in PIXELS — not cells, despite the "tmux-compatible alias" framing — and
 * each call doesn't necessarily move the border by exactly `amount` pixels (cmux clamps
 * to neighbour minimum sizes and rounds to whole cells), so we re-read after each call
 * and loop. We always resize the NEW pane: its border opposite the workspace edge IS the
 * split boundary we just created, which means cmux always sees an "adjacent border" to
 * move (no `invalid_state: no adjacent border` errors).
 */
async function resizeNewBorder(
    tree: Exclude<SplitTree, { kind: "leaf" }>,
    anchorSurface: string,
    newPaneRef: string,
    workspaceRef: string,
): Promise<void> {
    const MAX_ATTEMPTS = 8;
    let lastDelta = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const layout = await paneList(workspaceRef);
        const oldPane = layout.panes.find((p) => p.surface_refs.includes(anchorSurface));
        const newPane = layout.panes.find((p) => p.ref === newPaneRef);
        if (!oldPane || !newPane) {
            logger.warn(
                { anchorSurface, newPaneRef, kind: tree.kind },
                "[restore] could not locate split pair — aborting resize",
            );
            return;
        }

        // We pick which pane to resize based on direction. cmux's `resize-pane <dir>`
        // requires the pane to have a *neighbor* in that direction:
        //   -L on a left-edge pane errors ("no adjacent border in direction left")
        //   -D on a bottom-edge pane errors ("no adjacent border in direction down")
        // After a fresh split, the NEW pane is on the right/bottom. So:
        //   • Move the border to the LEFT (shrink old / grow new) → -L on NEW
        //   • Move the border to the RIGHT (grow old / shrink new) → -R on OLD
        //   • Move the border UP (shrink old top / grow new bottom) → -U on NEW
        //   • Move the border DOWN (grow old top / shrink new bottom) → -D on OLD
        // This way the chosen pane is always the one with a guaranteed neighbor in the
        // resize direction.
        if (tree.kind === "vsplit") {
            const totalCols = oldPane.columns + newPane.columns;
            const targetOldCols = Math.round(totalCols * tree.leftFraction);
            const deltaCells = oldPane.columns - targetOldCols;
            if (Math.abs(deltaCells) <= 1) {
                return;
            }
            if (Math.abs(deltaCells) >= lastDelta) {
                logger.warn(
                    { newPane: newPane.ref, deltaCells, lastDelta, attempt },
                    "[restore] vsplit resize made no progress — bailing",
                );
                return;
            }
            lastDelta = Math.abs(deltaCells);
            const target = deltaCells > 0 ? newPane : oldPane;
            const dir = deltaCells > 0 ? "-L" : "-R";
            const cellWidthPx = oldPane.cell_width_px || newPane.cell_width_px || 8;
            const amountPx = Math.max(1, Math.abs(deltaCells) * cellWidthPx);
            logger.debug(
                {
                    targetPane: target.ref,
                    dir,
                    amountPx,
                    deltaCells,
                    oldCols: oldPane.columns,
                    newCols: newPane.columns,
                    targetCols: targetOldCols,
                    fraction: tree.leftFraction,
                },
                "[restore] vsplit resize",
            );
            const moved = await tryResize(workspaceRef, target.ref, dir, amountPx);
            if (!moved) {
                return;
            }
            continue;
        }

        const totalRows = oldPane.rows + newPane.rows;
        const targetOldRows = Math.round(totalRows * tree.topFraction);
        const deltaCells = oldPane.rows - targetOldRows;
        if (Math.abs(deltaCells) <= 1) {
            return;
        }
        if (Math.abs(deltaCells) >= lastDelta) {
            logger.warn(
                { newPane: newPane.ref, deltaCells, lastDelta, attempt },
                "[restore] hsplit resize made no progress — bailing",
            );
            return;
        }
        lastDelta = Math.abs(deltaCells);
        const target = deltaCells > 0 ? newPane : oldPane;
        const dir = deltaCells > 0 ? "-U" : "-D";
        const cellHeightPx = oldPane.cell_height_px || newPane.cell_height_px || 17;
        const amountPx = Math.max(1, Math.abs(deltaCells) * cellHeightPx);
        logger.debug(
            {
                targetPane: target.ref,
                dir,
                amountPx,
                deltaCells,
                oldRows: oldPane.rows,
                newRows: newPane.rows,
                targetRows: targetOldRows,
                fraction: tree.topFraction,
            },
            "[restore] hsplit resize",
        );
        const moved = await tryResize(workspaceRef, target.ref, dir, amountPx);
        if (!moved) {
            return;
        }
    }
    logger.warn({ tree: tree.kind }, "[restore] split resize loop exhausted attempts");
}

async function tryResize(
    workspaceRef: string,
    paneRef: string,
    direction: "-L" | "-R" | "-U" | "-D",
    amount: number,
): Promise<boolean> {
    try {
        await runCmuxOk([
            "resize-pane",
            "--workspace",
            workspaceRef,
            "--pane",
            paneRef,
            direction,
            "--amount",
            String(amount),
        ]);
        return true;
    } catch (error) {
        logger.warn(
            { error, paneRef, direction, amount },
            "[restore] split-time resize failed",
        );
        return false;
    }
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
        // Use CLI `cmux new-surface` instead of raw RPC `surface.create` — the V1 RPC
        // ignores its explicit `pane`/`workspace` params and creates the surface in the
        // currently focused pane (same routing-bug class as `surface.split`). The CLI
        // routes through V2 and honors the params, so additional tabs land in the
        // correct pane instead of all stacking into the anchor.
        const args = [
            "new-surface",
            "--workspace",
            workspaceRef,
            "--pane",
            paneRef,
            "--type",
            nextSavedSurface.type,
        ];
        if (nextSavedSurface.type === "browser" && nextSavedSurface.url) {
            args.push("--url", nextSavedSurface.url);
        }
        const created = await runCmuxJSON<{ surface_ref: string; pane_ref: string }>(args);
        if (created.pane_ref !== paneRef) {
            logger.warn(
                { requested: paneRef, got: created.pane_ref, surfaceRef: created.surface_ref },
                "[restore] new-surface landed in unexpected pane",
            );
        }
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
    if (!opts.replay) {
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
        return;
    }

    // Build a single shell pipeline that:
    //   1. cd's to the saved cwd (silently — failures don't abort)
    //   2. clears the screen AND scrollback (\033[2J\033[3J\033[H), erasing both the
    //      shell's startup banner and the typed-input echo of this very command
    //   3. base64-decodes the saved screen contents to stdout, faithfully reproducing
    //      what the pane looked like when the profile was saved
    // Then, after the trailing newline, the saved last-typed command is sent (without
    // a newline) so it sits queued at the fresh prompt for the user to confirm — this
    // is what re-launches `claude --resume <id>`, `vim file`, etc.
    const parts: string[] = [];
    if (surface.cwd) {
        parts.push(`cd -- ${shellQuote(surface.cwd)} 2>/dev/null`);
    }
    if (surface.screen?.text) {
        const b64 = Buffer.from(surface.screen.text, "utf8").toString("base64");
        parts.push("printf '\\033[2J\\033[3J\\033[H'");
        parts.push(`printf %s '${b64}' | base64 -d`);
    }
    let payload = parts.length > 0 ? `${parts.join("; ")}\n` : "";
    if (surface.command && surface.command_source && surface.command_source !== "none") {
        payload += surface.command;
    }
    if (!payload) {
        return;
    }
    await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, payload]);
}
