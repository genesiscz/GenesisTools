import type { Pane, Profile, Surface, Workspace } from "@app/cmux/lib/types";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import { paneList, workspaceCreate } from "@genesiscz/utils/cmux/lib/socket";
import { applySplitTree, measureCellDelta, type SplitTree } from "@genesiscz/utils/cmux/split-tree";
import { logger } from "@genesiscz/utils/logger";

export type { SplitTree };

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

    const paneRefByIndex = await applySplitTree(buildSplitTree(ws.panes), workspaceRef);

    // applySplitTree resizes the new border immediately after each split, so by the
    // time the topology is fully built every saved fraction is already in place.
    // Verify and report any panes that ended up off (most likely cmux clamped a
    // resize at a minimum-pane-size limit).
    const maxDelta = await measureCellDelta(
        workspaceRef,
        ws.panes.map((pane) => ({ paneIndex: pane.index, columns: pane.columns, rows: pane.rows })),
        paneRefByIndex
    );

    for (const savedPane of ws.panes) {
        const paneRef = paneRefByIndex.get(savedPane.index);
        if (!paneRef) {
            continue;
        }
        await populatePane(savedPane, paneRef, workspaceRef, opts);
    }

    return { converged: maxDelta <= 1, maxCellDelta: maxDelta };
}

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
        return { kind: "leaf", paneIndex: rects[0].index };
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
        const args = ["new-surface", "--workspace", workspaceRef, "--pane", paneRef, "--type", nextSavedSurface.type];
        if (nextSavedSurface.type === "browser" && nextSavedSurface.url) {
            args.push("--url", nextSavedSurface.url);
        }
        const created = await runCmuxJSON<{ surface_ref: string; pane_ref: string }>(args);
        if (created.pane_ref !== paneRef) {
            logger.warn(
                { requested: paneRef, got: created.pane_ref, surfaceRef: created.surface_ref },
                "[restore] new-surface landed in unexpected pane"
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
