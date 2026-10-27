import { describeMatch, type FocusTarget, isUnambiguous } from "@app/claude/lib/cmux/focus";
import {
    findSessionTargets,
    identifiesExactSession,
    type ResolveDeps,
    retryAfterStaleRefs,
    type SessionTargetsResult,
    tmuxMissHint,
} from "@app/claude/lib/cmux/resolve";
import * as p from "@clack/prompts";
import type { RunningCmuxSession } from "@genesiscz/utils/ai/active-sessions";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { focusCmuxPane, focusCmuxSurface } from "@genesiscz/utils/cmux/lib/controls";
import { type CmuxIdentity, identifyCmux } from "@genesiscz/utils/cmux/lib/place";
import { isCmuxNotFound } from "@genesiscz/utils/cmux/lib/socket";
import { type CmuxTree, fetchCmuxTree } from "@genesiscz/utils/cmux/tree";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

const { log } = logger.scoped("claude-cmux-focus");

export interface FocusOptions {
    activate?: boolean;
    json?: boolean;
    dryRun?: boolean;
    first?: boolean;
    includeSelf?: boolean;
    /**
     * Focus only a pane proven to run the session (the hook journal, its resume command, its id in the tab title).
     * A full id printed on some screen is not proof: `ncdu /tmp` lists folders named after session ids, and an agent
     * pane that discussed the session prints it too (2026-10-25, a cache chip focused `ncdu /tmp`).
     */
    exact?: boolean;
}

export type FocusCommandDeps = ResolveDeps;

/**
 * The UUID of the cmux window that owns `workspaceId`.
 *
 * `identify --workspace <id>` answers for the workspace you name rather than the one you
 * are calling from, so this works when the pane lives in a window you are not in — which
 * is the whole point of a focus command.
 */
async function windowIdFor(workspaceId: string): Promise<string | undefined> {
    try {
        return (await identifyCmux({ workspace: workspaceId })).caller.windowId;
    } catch (err) {
        log.debug({ err, workspaceId }, "could not resolve the owning window; focusing without it");
        return undefined;
    }
}

/** Raise the cmux app itself, so a focused pane is actually on screen. */
export async function activateApp(identity?: CmuxIdentity): Promise<boolean> {
    if (process.platform !== "darwin") {
        log.debug({ platform: process.platform }, "app activation is macOS-only; skipped");
        return false;
    }

    try {
        const { bundleId } = identity ?? (await identifyCmux());

        if (!bundleId) {
            log.debug("identify returned no bundle_identifier; cannot raise the app");
            return false;
        }

        const proc = Bun.spawn(["open", "-b", bundleId], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;

        if (code !== 0) {
            log.warn({ bundleId, code, stderr: await new Response(proc.stderr).text() }, "open -b failed");
            return false;
        }

        log.debug({ bundleId }, "raised the cmux app");
        return true;
    } catch (err) {
        log.debug({ err }, "app activation failed");
        return false;
    }
}

/**
 * Raise window, pane, and tab for one target. Returns the window UUID used.
 *
 * A recorded target's surface IS the match, and the journal can outlive it (the tab was
 * closed, cmux restarted). So its tab is raised FIRST: a gone surface throws before any
 * window or pane moves, and the caller falls back to the matcher. Raising the window and
 * pane of a dead tab first left the user looking at an unrelated pane (2026-09-30).
 * A matcher target keeps the lenient pane-focused-but-tab-hidden behavior.
 */
export async function focusTarget(target: FocusTarget): Promise<string | undefined> {
    const recorded = target.matchedOn === "recorded" && Boolean(target.surfaceId);

    if (recorded && target.surfaceId) {
        await focusCmuxSurface({ surfaceId: target.surfaceId });
    }

    const windowId = target.windowId ?? (await windowIdFor(target.workspaceId));

    if (windowId) {
        await runCmuxOk(["focus-window", "--window", windowId]);
    }

    if (target.paneId) {
        await focusCmuxPane({ workspaceId: target.workspaceId, paneId: target.paneId });
    }

    if (target.surfaceId && !recorded) {
        // The match came from a background tab. Without this the pane is focused and the
        // command claims success while the user still looks at a different surface.
        try {
            await focusCmuxSurface({ surfaceId: target.surfaceId });
        } catch (err) {
            if (!target.paneId) {
                throw err;
            }
            log.warn({ err, surfaceId: target.surfaceId }, "could not focus the matched surface");
            out.printlnErr(pc.dim("  The pane is focused, but its matching tab could not be raised."));
        }
    }

    return windowId;
}

/** The tab a running session was found in, placed in its window, workspace and pane, or null when it closed. */
export function runningTarget(tree: CmuxTree, running: RunningCmuxSession): FocusTarget | null {
    const surfaceId = running.surfaceId.toLowerCase();

    for (const window of tree.windows) {
        for (const workspace of window.workspaces) {
            for (const pane of workspace.panes) {
                const surface = pane.surfaces.find((candidate) => candidate.id.toLowerCase() === surfaceId);

                if (surface) {
                    return {
                        workspaceId: workspace.id,
                        workspaceName: workspace.name,
                        paneId: pane.id,
                        paneTitle: pane.title,
                        ...(pane.cwd ? { cwd: pane.cwd } : {}),
                        windowId: window.id,
                        surfaceId: surface.id,
                        sessionIds: [running.sessionId],
                        matchedOn: "running",
                        score: 100,
                        active: pane.active,
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Focus the cmux tab where a running session's process was found (the resume picker's running rows), and raise
 * the app. The same raise as `tools claude cmux focus`, but on the tab the process scan proved, not on a fresh
 * text match: the hook journal can name an older tab. The tab is placed again in a fresh tree, because the picker
 * may have stayed open while it closed. Returns false, with the reason printed, when nothing was focused.
 */
export async function focusRunningSession(
    running: RunningCmuxSession,
    deps: { fetchTree?: () => Promise<CmuxTree>; focus?: typeof focusTarget; activate?: typeof activateApp } = {}
): Promise<boolean> {
    const tree = await (deps.fetchTree ?? fetchCmuxTree)();
    const label = running.surfaceRef ?? running.surfaceId;

    if (!tree.available) {
        out.error(pc.red(`cmux is not reachable: ${tree.error ?? "no answer"}`));
        return false;
    }

    const target = runningTarget(tree, running);

    if (!target) {
        out.error(
            pc.red(`The cmux tab ${label} closed; session ${running.sessionId.slice(0, 8)} no longer runs there.`)
        );
        out.printlnErr(pc.dim("  Run the same command again to resume it here."));
        return false;
    }

    log.debug({ sessionId: running.sessionId, surfaceId: target.surfaceId }, "focusing the running session's tab");
    await (deps.focus ?? focusTarget)(target);
    const activated = await (deps.activate ?? activateApp)();
    out.printlnErr(
        `${pc.green("✔")} ${pc.bold(target.workspaceName)} ${pc.dim(label)} ${pc.magenta(running.sessionId.slice(0, 8))} ` +
            pc.dim(`(${describeMatch(target)}; nothing was resumed)`)
    );

    if (!activated) {
        out.printlnErr(pc.dim("  The tab is focused, but the cmux app could not be raised. Switch to it by hand."));
    }

    return true;
}

function renderTargets(targets: FocusTarget[]): void {
    const table = createBoxTable(["WORKSPACE", "PANE", "MATCHED ON", "SESSION", "CWD"]);

    for (const target of targets) {
        table.push([
            pc.white(target.workspaceName),
            target.active ? pc.green(`${target.paneId} (active)`) : pc.dim(target.paneId),
            pc.cyan(describeMatch(target)),
            target.sessionIds.length > 0 ? pc.magenta(target.sessionIds[0].slice(0, 8)) : pc.dim("none"),
            truncateDisplay(target.cwd ?? "", 40),
        ]);
    }

    out.println(table.toString());
}

/**
 * The one pane to focus, or null when the caller must stop.
 *
 * Shared by the first pass and the stale-ref retry. The retry re-runs the
 * matcher with the recorded shortcut skipped, so it can match several panes
 * exactly like a first pass can, and every null path here has already reported.
 */
async function chooseTarget(targets: FocusTarget[], query: string, opts: FocusOptions): Promise<FocusTarget | null> {
    if (isUnambiguous(targets) || opts.first) {
        return targets[0];
    }

    if (opts.json) {
        // Nothing was focused, and `--json` has no TTY to disambiguate on, so this is
        // the same failure the non-TTY human path exits 1 for.
        process.exitCode = 1;
        out.result(SafeJSON.stringify({ query, focused: null, ambiguous: true, matches: targets }, null, 2));
        return null;
    }

    renderCliHeader("Several panes match", query);
    renderTargets(targets);

    if (!isInteractive()) {
        out.error(pc.red("Ambiguous match, and there is no TTY to ask on."));
        out.printlnErr(
            pc.dim(
                `  Narrow the query (a session id always wins), or take the top hit: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "focus", query, "--first"] })}`
            )
        );
        process.exit(1);
    }

    const picked = await pickTarget(targets);

    if (!picked) {
        out.printlnErr(pc.dim("Nothing picked, nothing focused."));
        return null;
    }

    return picked;
}

async function pickTarget(targets: FocusTarget[]): Promise<FocusTarget | null> {
    const choice = await p.select({
        message: "Which pane should I focus?",
        initialValue: targets[0].paneId,
        options: targets.map((target) => ({
            value: target.paneId,
            label: `${target.workspaceName} · ${target.paneId}`,
            hint: `${describeMatch(target)}${target.sessionIds.length > 0 ? ` · ${target.sessionIds[0].slice(0, 8)}` : ""}`,
        })),
    });

    if (p.isCancel(choice)) {
        return null;
    }

    return targets.find((target) => target.paneId === choice) ?? null;
}

/**
 * Focus the cmux pane a session is already open in.
 *
 * This never creates anything. A session with no pane is a `restore` job, and saying so
 * beats silently opening a second copy of a session that is already running somewhere.
 */
export async function focusCommand(query: string, opts: FocusOptions, deps: FocusCommandDeps = {}): Promise<void> {
    // Commander passes the Command as the third argument. Only tests inject deps.
    const queryTrim = query.trim();
    const result = await findSessionTargets(queryTrim, { includeSelf: opts.includeSelf, exact: opts.exact, deps });

    if (result.unavailable) {
        out.error(pc.red(`cmux is not reachable: ${result.unavailable}`));
        out.printlnErr(pc.dim("  Start cmux, then run this again."));
        process.exit(1);
    }

    const identity = result.identity;
    const targets = result.targets;
    log.debug({ query, matches: targets.length, source: result.source }, "focus match");

    if (targets.length === 0) {
        if (opts.json) {
            // Same failure as the human path below, so it has to carry the same exit code.
            // `{ focused: null }` on exit 0 reads as success to anything scripting this.
            process.exitCode = 1;
            const tmux = result.tmuxHosts?.length ? { tmux: result.tmuxHosts } : {};
            out.result(SafeJSON.stringify({ query, focused: null, matches: [], ...tmux }, null, 2));
            return;
        }

        out.error(pc.red(`No cmux pane matches "${query}".`));
        const tmuxHint = tmuxMissHint(result);

        if (tmuxHint) {
            out.printlnErr(pc.dim(`  ${tmuxHint}`));
        }

        if (result.snapshot) {
            out.printlnErr(
                pc.dim(
                    `  Searched ${result.snapshot.panes.length} pane(s) across ${result.snapshot.workspaces.length}.`
                )
            );
        }
        out.printlnErr(
            pc.dim(
                `  If the session is not open anywhere, reopen it: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "restore"] })}`
            )
        );
        process.exit(1);
    }

    const acceptsExact = (found: SessionTargetsResult): boolean => {
        if (!opts.exact || identifiesExactSession(found)) {
            return true;
        }

        process.exitCode = 1;

        if (opts.json) {
            out.result(SafeJSON.stringify({ query, focused: null, exact: false, matches: found.targets }, null, 2));
            return false;
        }

        const [best] = found.targets;
        out.error(pc.red(`No cmux pane is proven to run ${query.slice(0, 8)}; nothing was focused.`));
        out.printlnErr(
            pc.dim(
                `  ${found.targets.length} pane(s) only show its id on screen${best ? ` (best: ${describeMatch(best)})` : ""}.`
            )
        );
        out.printlnErr(
            pc.dim(`  Pick one anyway: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "focus", query] })}`)
        );
        return false;
    };

    if (!acceptsExact(result)) {
        return;
    }

    let target = await chooseTarget(opts.exact ? targets.slice(0, 1) : targets, query, opts);

    if (!target) {
        return;
    }

    if (opts.dryRun) {
        const plan = {
            query,
            wouldFocus: target,
            activate: opts.activate !== false,
        };

        if (opts.json) {
            out.result(SafeJSON.stringify(plan, null, 2));
            return;
        }

        renderCliHeader("Dry run", "nothing was focused");
        renderTargets([target]);
        return;
    }

    let windowId: string | undefined;

    try {
        windowId = await focusTarget(target);
    } catch (err) {
        // Only cmux saying not_found proves the recorded pane closed. A timeout, a broken socket, another
        // refusal or a malformed reply says nothing about the pane, so it is reported as the error it is.
        if (result.source !== "recorded" || !isCmuxNotFound(err)) {
            throw err;
        }
        // Recorded refs outlived their pane (cmux restart). Fall back to the matcher.
        log.debug({ err }, "recorded cmux refs are stale; retrying with the text matcher");
        const retry = await retryAfterStaleRefs(
            queryTrim,
            { includeSelf: opts.includeSelf, exact: opts.exact, deps },
            (found) =>
                acceptsExact(found)
                    ? chooseTarget(opts.exact ? found.targets.slice(0, 1) : found.targets, query, opts)
                    : Promise.resolve(null)
        );

        if (retry.status === "stopped") {
            return;
        }

        if (retry.status === "empty") {
            process.exitCode = 1;

            if (opts.json) {
                // `gone`: the session had a pane and it closed. Callers say so and offer a new
                // pane instead of showing cmux's not_found.
                out.result(SafeJSON.stringify({ query, focused: null, gone: true, matches: [] }, null, 2));
                return;
            }

            out.error(
                pc.red(`That cmux pane is gone: the tab session ${query.slice(0, 8)} last ran in no longer exists.`)
            );
            out.printlnErr(
                pc.dim(
                    `  Resume it in a new pane: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "open-session", query] })}`
                )
            );
            return;
        }

        target = retry.target;
        windowId = await focusTarget(target);
    }

    const activated = opts.activate === false ? false : await activateApp(identity);

    if (opts.json) {
        out.result(SafeJSON.stringify({ query, focused: target, windowId, activated }, null, 2));
        return;
    }

    const session = target.sessionIds.length > 0 ? pc.magenta(target.sessionIds[0].slice(0, 8)) : pc.dim("no session");
    out.printlnErr(
        `${pc.green("✔")} ${pc.bold(target.workspaceName)} ${pc.dim(target.paneId)} ${session} ` +
            pc.dim(`(matched on ${describeMatch(target)})`)
    );

    if (!activated && opts.activate !== false) {
        out.printlnErr(pc.dim("  Pane focused, but the cmux app could not be raised. Switch to it by hand."));
    }
}
