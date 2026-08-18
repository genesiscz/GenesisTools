import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { type PaneListPane, paneList, type SurfaceSplitResult } from "@genesiscz/utils/cmux/lib/socket";
import { logger } from "@genesiscz/utils/logger";

/**
 * A cmux pane layout expressed as nested binary splits — the only shape cmux can
 * actually rebuild, since every pane is created by splitting another one.
 *
 * `paneIndex` on a leaf is the caller's own numbering (a saved profile's pane index,
 * a grid cell, …); `applySplitTree` hands back the live pane ref for each one.
 */
export type SplitTree =
    | { kind: "leaf"; paneIndex: number }
    | {
          kind: "vsplit";
          left: SplitTree;
          right: SplitTree;
          /** Fraction of the parent's width occupied by the left subtree (0..1). */
          leftFraction: number;
      }
    | {
          kind: "hsplit";
          top: SplitTree;
          bottom: SplitTree;
          /** Fraction of the parent's height occupied by the top subtree (0..1). */
          topFraction: number;
      };

/**
 * Rebuild `tree` in a workspace that currently holds exactly one pane, and return
 * the live pane ref for every leaf index.
 *
 * The workspace must already be FOCUSED (wrap the call in `withFocusedWorkspace`):
 * cmux resolves several of these verbs against the rendered workspace, and a
 * background workspace reports stale geometry.
 */
export async function applySplitTree(tree: SplitTree, workspaceRef: string): Promise<Map<number, string>> {
    const initialLayout = await paneList(workspaceRef);

    if (initialLayout.panes.length !== 1) {
        throw new Error(`Expected a workspace with 1 pane, got ${initialLayout.panes.length}`);
    }

    const rootSurface = initialLayout.panes[0].selected_surface_ref;
    const paneRefByIndex = new Map<number, string>();
    await applyTree(tree, rootSurface, workspaceRef, paneRefByIndex);

    return paneRefByIndex;
}

/**
 * Largest |wanted - actual| over all panes and both dimensions, in terminal cells.
 * `applySplitTree` resizes each border at split time, so this is a verification
 * read: a large delta means cmux clamped a resize at a minimum-pane-size limit.
 *
 * The last pane split may still be missing its cell geometry, so this waits one
 * render tick for it rather than reporting a delta it cannot compute.
 */
export async function measureCellDelta(
    workspaceRef: string,
    wanted: Array<{ paneIndex: number; columns: number; rows: number }>,
    paneRefByIndex: Map<number, string>
): Promise<number> {
    let layout = await paneList(workspaceRef);

    if (layout.panes.some((pane) => !Number.isFinite(pane.columns))) {
        await Bun.sleep(GEOMETRY_SETTLE_MS);
        layout = await paneList(workspaceRef);
    }

    let maxDelta = 0;

    for (const want of wanted) {
        const ref = paneRefByIndex.get(want.paneIndex);

        if (!ref) {
            logger.warn(
                { paneIndex: want.paneIndex, mappedKeys: [...paneRefByIndex.keys()] },
                "[split-tree] pane index has no live pane mapping"
            );
            continue;
        }

        const live = layout.panes.find((p) => p.ref === ref);

        if (!live || !Number.isFinite(live.columns) || !Number.isFinite(live.rows)) {
            logger.debug({ ref }, "[split-tree] pane has no cell geometry yet — excluded from the delta");
            continue;
        }

        maxDelta = Math.max(
            maxDelta,
            Math.abs(want.columns - (live.columns as number)),
            Math.abs(want.rows - (live.rows as number))
        );
    }

    return maxDelta;
}

/** One render tick: how long cmux takes to report a new pane's cell geometry. */
const GEOMETRY_SETTLE_MS = 150;

/**
 * Walk the split tree and recreate the layout in cmux. After EACH split we resize the
 * just-created border to match the wanted fraction — at that moment only two panes share
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

        logger.debug({ anchor: anchorSurface, paneRef: pane.ref, paneIndex: tree.paneIndex }, "[split-tree] leaf");
        map.set(tree.paneIndex, pane.ref);
        return;
    }

    const direction = tree.kind === "vsplit" ? "right" : "down";
    const split = await splitFromSurface(direction, anchorSurface, workspaceRef);
    logger.debug(
        { direction, anchor: anchorSurface, newPane: split.pane_ref, newSurface: split.surface_ref },
        "[split-tree] split"
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
 * `newPaneRef` until the wanted fraction is reached. cmux's `resize-pane --amount` is in
 * PIXELS — not cells, despite the "tmux-compatible alias" framing — and each call doesn't
 * necessarily move the border by exactly `amount` pixels (cmux clamps to neighbour minimum
 * sizes and rounds to whole cells), so we re-read after each call and loop.
 *
 * The math runs on `pixel_frame`, the ONLY geometry a freshly split pane reports: its
 * `columns`/`rows` arrive a render tick later, and computing with them produced
 * `--amount NaN` on every split, silently leaving cmux's default 50/50 in place.
 *
 * We always resize the NEW pane: its border opposite the workspace edge IS the split
 * boundary we just created, which means cmux always sees an "adjacent border" to move
 * (no `invalid_state: no adjacent border` errors).
 */
async function resizeNewBorder(
    tree: Exclude<SplitTree, { kind: "leaf" }>,
    anchorSurface: string,
    newPaneRef: string,
    workspaceRef: string
): Promise<void> {
    const MAX_ATTEMPTS = 8;
    const vsplit = tree.kind === "vsplit";
    const fraction = vsplit ? tree.leftFraction : tree.topFraction;
    let lastDeltaPx = Number.POSITIVE_INFINITY;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const layout = await paneList(workspaceRef);
        const oldPane = layout.panes.find((p) => p.surface_refs.includes(anchorSurface));
        const newPane = layout.panes.find((p) => p.ref === newPaneRef);

        if (!oldPane || !newPane) {
            logger.warn(
                { anchorSurface, newPaneRef, kind: tree.kind },
                "[split-tree] could not locate split pair — aborting resize"
            );
            return;
        }

        const step = resizeStep({ oldPane, newPane, vsplit, fraction, lastDeltaPx });
        logger.debug({ step, oldPane: oldPane.ref, newPane: newPane.ref, attempt }, "[split-tree] resize step");

        if (step.kind !== "move") {
            if (step.kind === "stuck") {
                logger.warn({ newPane: newPane.ref, attempt, reason: step.reason }, "[split-tree] resize gave up");
            }

            return;
        }

        lastDeltaPx = step.deltaPx;
        const moved = await tryResize(
            workspaceRef,
            step.target === "new" ? newPane.ref : oldPane.ref,
            step.direction,
            step.amountPx
        );

        if (!moved) {
            return;
        }
    }

    logger.warn({ tree: tree.kind }, "[split-tree] split resize loop exhausted attempts");
}

export type ResizeStep =
    | { kind: "done" }
    | { kind: "stuck"; reason: "no-geometry" | "no-progress" }
    | {
          kind: "move";
          target: "old" | "new";
          direction: "-L" | "-R" | "-U" | "-D";
          amountPx: number;
          /** |wanted - actual| for this step, so the caller can detect a stall. */
          deltaPx: number;
      };

/**
 * One resize decision, in pixels.
 *
 * Deliberately pure and pixel-based: `pixel_frame` is the only geometry a pane reports
 * before cmux renders it, and doing this arithmetic on `columns`/`rows` yielded NaN on
 * every freshly split pane — which sent `resize-pane --amount NaN`, failed silently, and
 * left cmux's default 50/50 split in place of the fraction we asked for.
 */
export function resizeStep(input: {
    oldPane: PaneListPane;
    newPane: PaneListPane;
    vsplit: boolean;
    fraction: number;
    lastDeltaPx: number;
}): ResizeStep {
    const { oldPane, newPane, vsplit, fraction } = input;
    const oldSize = vsplit ? oldPane.pixel_frame?.width : oldPane.pixel_frame?.height;
    const newSize = vsplit ? newPane.pixel_frame?.width : newPane.pixel_frame?.height;

    if (!Number.isFinite(oldSize) || !Number.isFinite(newSize)) {
        return { kind: "stuck", reason: "no-geometry" };
    }

    // One cell is the tolerance: anything finer is invisible and cmux rounds it away.
    const cellPx = vsplit
        ? oldPane.cell_width_px || newPane.cell_width_px || 8
        : oldPane.cell_height_px || newPane.cell_height_px || 17;
    const deltaPx = (oldSize as number) - ((oldSize as number) + (newSize as number)) * fraction;

    if (Math.abs(deltaPx) <= cellPx) {
        return { kind: "done" };
    }

    if (Math.abs(deltaPx) >= input.lastDeltaPx) {
        return { kind: "stuck", reason: "no-progress" };
    }

    // Positive delta: the old pane is too big, so the border moves toward it. The pane
    // we resize is always the one with a neighbour in that direction, or cmux answers
    // `invalid_state: no adjacent border`.
    return {
        kind: "move",
        target: deltaPx > 0 ? "new" : "old",
        direction: vsplit ? (deltaPx > 0 ? "-L" : "-R") : deltaPx > 0 ? "-U" : "-D",
        amountPx: Math.max(1, Math.round(Math.abs(deltaPx))),
        deltaPx: Math.abs(deltaPx),
    };
}

async function tryResize(
    workspaceRef: string,
    paneRef: string,
    direction: "-L" | "-R" | "-U" | "-D",
    amount: number
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
        logger.warn({ error, paneRef, direction, amount }, "[split-tree] split-time resize failed");
        return false;
    }
}

async function splitFromSurface(
    direction: "right" | "down",
    surfaceRef: string,
    workspaceRef: string
): Promise<SurfaceSplitResult> {
    // CLI `new-split` rather than the raw `surface.split` RPC: the V1 RPC ignores its
    // explicit pane/workspace params and splits whatever pane is focused.
    return runCmuxJSON<SurfaceSplitResult>([
        "new-split",
        direction,
        "--workspace",
        workspaceRef,
        "--surface",
        surfaceRef,
    ]);
}
