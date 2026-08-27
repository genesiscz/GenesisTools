import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pane, Profile, Surface, Workspace } from "@app/cmux/lib/types";
import * as p from "@clack/prompts";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import { paneList, workspaceCreate } from "@genesiscz/utils/cmux/lib/socket";
import { applySplitTree, measureCellDelta, type SplitTree } from "@genesiscz/utils/cmux/split-tree";
import { logger } from "@genesiscz/utils/logger";
import pc from "picocolors";

export type { SplitTree };

const EDGE_TOLERANCE_PX = 2;

export interface RestoreOptions {
    prefix: string;
    replay: boolean;
    /** Also press Enter after typing the replayed command, so it executes immediately. */
    enter: boolean;
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

    // cmux inserts each new tab immediately after the anchor, which reverses the tail
    // order for multi-tab panes. Put every surface back at its saved index, then land
    // the pane's selection on the saved active tab.
    const reorder = async (surfaceRef: string, index: number, focus: boolean): Promise<void> => {
        await runCmuxOk([
            "reorder-surface",
            "--workspace",
            workspaceRef,
            "--surface",
            surfaceRef,
            "--index",
            String(index),
            "--focus",
            String(focus),
        ]).catch((error) => {
            logger.debug({ error, surfaceRef, index, focus }, "[restore] reorder-surface failed");
        });
    };

    if (expectedCount > 1) {
        for (let i = 0; i < surfaceRefs.length; i += 1) {
            await reorder(surfaceRefs[i], i, false);
        }
    }

    // cmux leaves the last-created tab selected, so the saved selection must be
    // restored explicitly even when it is the first tab.
    const selectedIndex = savedPane.selected_surface_index;

    if (surfaceRefs.length > 1 && selectedIndex >= 0 && selectedIndex < surfaceRefs.length) {
        await reorder(surfaceRefs[selectedIndex], selectedIndex, true);
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

/**
 * Interactive prompts a replayed command can stop at. Restore NEVER answers these
 * (Martin's rule: type the command + Enter, nothing more) — it only reports which
 * panes are waiting so the user confirms each one deliberately.
 */
const INTERACTIVE_PROMPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /Launch anyway\?/, label: "account-headroom gate (weekly limit spent — Launch anyway?)" },
    { pattern: /Resume full session as-is/, label: "resume-mode dialog (summary vs full session)" },
    { pattern: /NAME\s+BRANCH\s+AGE/, label: "session picker (verify the highlighted session before Enter!)" },
    { pattern: /Select session to resume/, label: "session picker (verify the highlighted session before Enter!)" },
];

export function detectInteractivePrompt(screenText: string): string | undefined {
    for (const { pattern, label } of INTERACTIVE_PROMPT_PATTERNS) {
        if (pattern.test(screenText)) {
            return label;
        }
    }

    return undefined;
}

export interface WaitingPane {
    workspaceRef: string;
    surfaceRef: string;
    prompt: string;
}

/** Scan the restored workspaces for panes stopped at an interactive prompt. Read-only. */
export async function scanForInteractivePrompts(workspaceRefs: string[]): Promise<WaitingPane[]> {
    const waiting: WaitingPane[] = [];

    for (const workspaceRef of workspaceRefs) {
        const layout = await paneList(workspaceRef);
        for (const pane of layout.panes) {
            for (const surfaceRef of pane.surface_refs) {
                const result = await runCmuxOk([
                    "read-screen",
                    "--workspace",
                    workspaceRef,
                    "--surface",
                    surfaceRef,
                ]).catch(() => undefined);
                if (!result) {
                    continue;
                }

                const prompt = detectInteractivePrompt(result.stdout);
                if (prompt) {
                    waiting.push({ workspaceRef, surfaceRef, prompt });
                }
            }
        }
    }

    return waiting;
}

/**
 * Report the panes a run left sitting at an interactive prompt. Neither rescue
 * nor restore ever answers one: confirming an account-headroom gate or a session
 * picker on the user's behalf is exactly the automation this tool refuses.
 *
 * `actor` only names the caller in the advice line — the scan is identical, and
 * having two copies of it meant a fix to one never reached the other.
 */
export async function reportWaitingPrompts(workspaceRefs: string[], actor: "Rescue" | "Restore"): Promise<void> {
    // The replayed commands need a moment to draw whatever they are going to ask.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    let waiting: WaitingPane[];
    try {
        waiting = await scanForInteractivePrompts(workspaceRefs);
    } catch (error) {
        // Reporting "nothing is waiting" here would be a lie: the scan never ran.
        logger.debug({ error, actor }, "[cmux] waiting-prompt scan failed");

        return;
    }

    if (waiting.length === 0) {
        p.log.info("No panes are waiting at an interactive prompt.");

        return;
    }

    p.note(formatWaitingPanes(waiting, actor).join("\n"), "Panes waiting for you");
}

/** The note body: one line per waiting pane, then the advice line. Pure, so it is testable. */
export function formatWaitingPanes(waiting: WaitingPane[], actor: "Rescue" | "Restore"): string[] {
    const lines = waiting.map((w) => `  ${pc.yellow("⚠")} ${w.workspaceRef} ${w.surfaceRef} — ${w.prompt}`);
    lines.push(pc.dim(`  ${actor} does not auto-confirm these; answer each pane yourself.`));

    return lines;
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
    //   3. cats the saved screen contents from a temp file, faithfully reproducing
    //      what the pane looked like when the profile was saved. The content goes
    //      through a file, NOT inline base64 — a full pane screen inlined into one
    //      typed line exceeds the pty input limit and the shell echoes the mangled
    //      command as garbage instead of executing it.
    // Then, after the trailing newline, the saved last-typed command is sent (without
    // a newline) so it sits queued at the fresh prompt for the user to confirm — this
    // is what re-launches `claude --resume <id>`, `vim file`, etc.
    const parts: string[] = [];
    if (surface.cwd) {
        parts.push(`cd -- ${shellQuote(surface.cwd)} 2>/dev/null`);
    }
    // The screen text can hold tokens and private output, so it goes into a fresh
    // 0700 mkdtemp dir (unpredictable path, unreadable by other local users). The
    // replayed pipeline itself deletes the dir right after the cat — the pane's
    // shell is the only consumer, so that is the earliest race-free moment.
    let screenDir: string | undefined;
    if (surface.screen?.text) {
        screenDir = await mkdtemp(join(tmpdir(), "cmux-restore-screen-"));
        const screenFile = join(screenDir, `${surfaceRef.replace(/[^A-Za-z0-9]/g, "-")}.txt`);
        await Bun.write(screenFile, surface.screen.text);
        parts.push("printf '\\033[2J\\033[3J\\033[H'");
        parts.push(`cat -- ${shellQuote(screenFile)}`);
        parts.push(`rm -rf -- ${shellQuote(screenDir)}`);
    }
    let payload = parts.length > 0 ? `${parts.join("; ")}\n` : "";
    if (surface.command && surface.command_source && surface.command_source !== "none") {
        payload += opts.enter ? `${surface.command}\n` : surface.command;
    }
    if (!payload) {
        return;
    }

    try {
        await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, payload]);
    } catch (error) {
        if (screenDir) {
            // The pipeline never reached the pane, so nothing will consume the file.
            await rm(screenDir, { recursive: true, force: true }).catch((cleanupError) => {
                logger.debug({ error: cleanupError, dir: screenDir }, "[restore] screen temp cleanup failed");
            });
        }

        throw error;
    }
}
