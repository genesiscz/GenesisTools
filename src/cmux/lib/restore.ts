import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueReplayCommand } from "@app/cmux/lib/replay-input";
import { isShellPromptReady, waitForTerminalText } from "@app/cmux/lib/terminal-ready";
import type { Pane, Profile, Surface, Workspace } from "@app/cmux/lib/types";
import { resolveWindowRef } from "@app/cmux/lib/window-ref";
import * as p from "@clack/prompts";
import { runCmuxJSON, runCmuxOk, sendSurfaceText } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import { paneList, windowList, workspaceCreate } from "@genesiscz/utils/cmux/lib/socket";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
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
    /** Explicit destination; otherwise cmux uses the current window. */
    window?: string;
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
        /** Null when the source autosave had estimated rather than measured cell sizes. */
        maxCellDelta: number | null;
        failures: Array<{ paneRef: string; message: string }>;
    }>;
}

export function restoreFailureMessages(outcome: RestoreOutcome): string[] {
    return outcome.workspaces.flatMap((workspace) =>
        workspace.failures.map((failure) => `${workspace.title} / ${failure.paneRef}: ${failure.message}`)
    );
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

/**
 * Restore an ALREADY prepared profile (see `prepareProfileForRestore`).
 *
 * Preparing again here re-ran the whole inference over its own output: the
 * synthetic `claude --resume '<id>'` from pass 1 became pass 2's "original", so
 * the command typed differed from the plan the user had just confirmed and the
 * drift note described a replacement that never happened. It also paid for a
 * second Claude session-listing scan and a second grok directory walk.
 */
export async function restoreProfile(
    playable: Profile,
    opts: RestoreOptions,
    events: RestoreEvents = {}
): Promise<RestoreOutcome> {
    const outcome: RestoreOutcome = { workspaces: [] };
    const previousWorkspaceByWindow = new Map<string, string>();
    const targetWindow = opts.window ? resolveWindowRef(opts.window, await windowList()) : undefined;
    const totalWorkspaces = playable.windows.reduce((acc, w) => acc + w.workspaces.length, 0);
    let visited = 0;

    for (const window of playable.windows) {
        for (const ws of window.workspaces) {
            visited += 1;
            const targetTitle = `${opts.prefix}${ws.title}`;
            events.onWorkspaceStart?.({ title: targetTitle, index: visited, total: totalWorkspaces });

            const created = await workspaceCreate({
                name: targetTitle,
                window: targetWindow,
                cwd: ws.current_directory,
            });
            const previousWorkspace = previousWorkspaceByWindow.get(created.window_ref);
            if (previousWorkspace) {
                await runCmuxOk([
                    "reorder-workspace",
                    "--workspace",
                    created.workspace_ref,
                    "--after",
                    previousWorkspace,
                    "--window",
                    created.window_ref,
                ]).catch((error) => {
                    logger.warn(
                        { error, workspaceRef: created.workspace_ref },
                        "[restore] workspace reorder failed; continuing restore"
                    );
                });
            }

            previousWorkspaceByWindow.set(created.window_ref, created.workspace_ref);

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
                converged: !playable.cmux_version.startsWith("offline ") && result.converged,
                maxCellDelta: playable.cmux_version.startsWith("offline ") ? null : result.maxCellDelta,
                failures: result.failures,
            });
            events.onWorkspaceDone?.({ ref: created.workspace_ref, title: targetTitle });
        }
    }
    return outcome;
}

interface MaterializeResult {
    converged: boolean;
    failures: Array<{ paneRef: string; message: string }>;
    /** Largest |saved - actual| over all panes / dimensions, in terminal cells. */
    maxCellDelta: number;
}

export async function materializeWorkspace(
    ws: Workspace,
    workspaceRef: string,
    opts: RestoreOptions
): Promise<MaterializeResult> {
    if (ws.panes.length === 0) {
        return { converged: true, maxCellDelta: 0, failures: [] };
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

    const failures: MaterializeResult["failures"] = [];
    for (const savedPane of ws.panes) {
        const paneRef = paneRefByIndex.get(savedPane.index);
        if (!paneRef) {
            failures.push({ paneRef: `saved pane ${savedPane.index}`, message: "No restored pane mapping" });
            continue;
        }
        try {
            await populatePane(savedPane, paneRef, workspaceRef, opts);
        } catch (error) {
            failures.push({ paneRef, message: error instanceof Error ? error.message : String(error) });
            logger.warn(
                { error, paneRef, workspaceRef },
                "[restore] pane population failed; continuing with remaining panes"
            );
        }
    }

    return { converged: failures.length === 0 && maxDelta <= 1, maxCellDelta: maxDelta, failures };
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
    const firstSurface = savedPane.surfaces[0];
    if (firstSurface.type === "browser") {
        if (surfaceRefs.length !== 1) {
            throw new Error(`Expected one fresh restore anchor in ${paneRef}; refusing to replace existing tabs`);
        }

        const args = ["new-surface", "--workspace", workspaceRef, "--pane", paneRef, "--type", "browser"];
        if (firstSurface.url) {
            args.push("--url", firstSurface.url);
        }

        const browser = await runCmuxJSON<{ surface_ref: string; pane_ref: string }>(args);
        if (browser.pane_ref !== paneRef) {
            throw new Error(`Browser restore landed in ${browser.pane_ref}, expected ${paneRef}`);
        }

        await runCmuxOk(["close-surface", "--surface", surfaceRefs[0]]);
        surfaceRefs[0] = browser.surface_ref;
    }

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
    const notReplayed: string[] = [];

    try {
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
                const skipped = await replayTerminal(savedSurface, workspaceRef, surfaceRef, opts);
                if (skipped) {
                    notReplayed.push(skipped);
                }
            }
        }
    } finally {
        if (selectedIndex >= 0 && selectedIndex < surfaceRefs.length) {
            await reorder(surfaceRefs[selectedIndex], selectedIndex, true);
        }
    }

    // A refused pretype leaves the pane short of what was saved, so the outcome has
    // to say so instead of printing Done. Raised after the loop, not inside it, so
    // the pane's remaining tabs are still restored.
    if (notReplayed.length > 0) {
        throw new Error(notReplayed.join("; "));
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
    { pattern: /Do you trust the contents of this directory\?/, label: "directory-trust prompt" },
    {
        pattern: /No saved session found|No conversation found with session ID|Failed to resume session/,
        label: "resume failed; inspect the terminal error",
    },
    { pattern: /already has an active writer/, label: "session already running in another terminal" },
    { pattern: /Use session directory[\s\S]*Use current directory/, label: "directory-choice dialog" },
    { pattern: /(?:cmdand )?quote>/, label: "shell continuation or malformed replay text" },
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
export async function scanForInteractivePrompts(workspaceRefs: string[]): Promise<PromptScanResult> {
    const waiting: WaitingPane[] = [];
    const failures: string[] = [];

    for (const workspaceRef of workspaceRefs) {
        const layout = await paneList(workspaceRef).catch((error) => {
            logger.debug({ error, workspaceRef }, "[restore] prompt scan pane listing failed");
            failures.push(workspaceRef);
            return undefined;
        });
        if (!layout) {
            continue;
        }

        for (const pane of layout.panes) {
            const listing = await runCmuxJSON<{ surfaces: Array<{ ref: string; type: string }> }>([
                "list-pane-surfaces",
                "--workspace",
                workspaceRef,
                "--pane",
                pane.ref,
            ]).catch((error) => {
                logger.debug(
                    { error, workspaceRef, paneRef: pane.ref },
                    "[restore] prompt scan surface listing failed"
                );
                failures.push(`${workspaceRef} ${pane.ref}`);
                return undefined;
            });
            if (!listing) {
                continue;
            }

            for (const surface of listing.surfaces) {
                if (surface.type !== "terminal") {
                    continue;
                }

                const surfaceRef = surface.ref;
                const result = await runCmuxOk([
                    "read-screen",
                    "--workspace",
                    workspaceRef,
                    "--surface",
                    surfaceRef,
                ]).catch((error) => {
                    logger.debug({ error, workspaceRef, surfaceRef }, "[restore] prompt scan screen read failed");
                    failures.push(`${workspaceRef} ${surfaceRef}`);
                    return undefined;
                });
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

    return { waiting, failures };
}

export interface PromptScanResult {
    waiting: WaitingPane[];
    failures: string[];
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

    let result: PromptScanResult;
    try {
        result = await scanForInteractivePrompts(workspaceRefs);
    } catch (error) {
        // Reporting "nothing is waiting" here would be a lie: the scan never ran.
        logger.debug({ error, actor }, "[cmux] waiting-prompt scan failed");
        p.log.warn("Could not check restored terminals for interactive prompts. Check them manually.");

        return;
    }

    const { waiting, failures } = result;
    if (failures.length > 0) {
        p.log.warn(`Prompt scan incomplete. Could not check: ${failures.join(", ")}. Check these manually.`);
    }

    if (waiting.length === 0) {
        if (failures.length === 0) {
            p.log.info("No recognized interactive prompts found in the restored terminals.");
        }

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

/**
 * The setup steps chain with `&&` — a `cat` of the saved screen must not run if the `printf`
 * that cleared it failed. `always` is different: it runs whatever the chain did, because it
 * carries the readiness marker, and a marker that never prints is not a smaller failure.
 *
 * `cd` into a saved directory that no longer exists (a removed worktree, a renamed project) is
 * the ordinary case, and gating the marker on it made `waitForTerminalText` burn its 30 s and
 * throw, which aborted every LATER tab of the same pane before it was renamed or replayed.
 */
export function internalRestoreCommand(parts: string[], always: string[] = []): string {
    const body = [parts.join(" && "), ...always].filter((part) => part.length > 0).join("; ");

    return `function _genesis_cmux_restore_internal { ${body}; }; _genesis_cmux_restore_internal; unset -f _genesis_cmux_restore_internal\n`;
}

/** Resolves to a reason string when the surface was restored but its saved command was NOT replayed. */
async function replayTerminal(
    surface: Surface & { type: "terminal" },
    workspaceRef: string,
    surfaceRef: string,
    opts: RestoreOptions
): Promise<string | undefined> {
    await waitForTerminalText({
        workspaceRef,
        surfaceRef,
        matches: isShellPromptReady,
        description: "shell prompt",
        activateOnUnavailable: true,
    });
    if (!opts.replay) {
        if (surface.cwd) {
            await sendSurfaceText({ surfaceRef, text: internalRestoreCommand([`cd -- ${shellQuote(surface.cwd)}`]) });
        }
        return;
    }

    // Acknowledge directory setup before replay. Render saved output only after
    // clearing the setup text, so the readiness marker is not left on screen and
    // the saved transcript survives the redraw.
    const parts: string[] = [];
    const screenParts: string[] = [];
    if (surface.cwd) {
        parts.push(`cd -- ${shellQuote(surface.cwd)}`);
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
        screenParts.push("printf '\\033[2J\\033[H'");
        screenParts.push(`cat -- ${shellQuote(screenFile)}`);
        screenParts.push(`rm -rf -- ${shellQuote(screenDir)}`);
    }
    try {
        if (parts.length > 0) {
            const marker = `cmux-ready-${crypto.randomUUID()}`;
            // Split the marker across printf arguments so input echo cannot acknowledge setup.
            const ready = `printf '\\n%s%s\\n' 'cmux-ready-' '${marker.slice("cmux-ready-".length)}'`;
            await sendSurfaceText({ surfaceRef, text: internalRestoreCommand(parts, [ready]) });
            await waitForTerminalText({
                workspaceRef,
                surfaceRef,
                matches: (text) => text.split("\n").some((line) => line.trim() === marker) && isShellPromptReady(text),
                description: "working-directory and screen setup",
            });
        }

        await runCmuxOk(["send-key", ...surfaceTargetArgs(surfaceRef, workspaceRef), "ctrl-l"]);

        if (screenParts.length > 0) {
            await sendSurfaceText({ surfaceRef, text: internalRestoreCommand(screenParts) });
        }

        if (surface.command && surface.command_source && surface.command_source !== "none") {
            if (!(await queueReplayCommand({ surfaceRef, command: surface.command, enter: opts.enter }))) {
                return `${surfaceRef}: saved command not replayed (multiline/control input needs --enter)`;
            }
        }
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
