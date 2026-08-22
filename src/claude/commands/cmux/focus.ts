import { describeMatch, type FocusTarget, findFocusTargets, isUnambiguous } from "@app/claude/lib/cmux/focus";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { focusCmuxPane, focusCmuxSurface } from "@genesiscz/utils/cmux/lib/controls";
import { fetchCmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

const { log } = logger.scoped("claude-cmux-focus");

export interface FocusOptions {
    activate?: boolean;
    json?: boolean;
    dryRun?: boolean;
    first?: boolean;
    includeSelf?: boolean;
}

export interface FocusCommandDeps {
    fetchSnapshot?: typeof fetchCmuxLiveSnapshot;
}

interface IdentifyResponse {
    bundle_identifier?: string;
    caller?: { window_ref?: string; pane_ref?: string };
}

/**
 * Who we are and which pane we are in, when this process is running inside cmux at all.
 *
 * Needed because typing the query puts it on the caller's own screen, so without this the
 * weak text rule matches the calling pane for every query. Also carries the bundle id
 * `activateApp` needs, so focus does not spend a second `identify` after the snapshot.
 */
async function identifyCmux(): Promise<IdentifyResponse | undefined> {
    try {
        return await runCmuxJSON<IdentifyResponse>(["identify"]);
    } catch (err) {
        log.debug({ err }, "could not identify the calling pane; searching every pane");
        return undefined;
    }
}

/**
 * The cmux window that owns `workspaceRef`.
 *
 * `identify --workspace <ref>` answers for the workspace you name rather than the one you
 * are calling from, so this works when the pane lives in a window you are not in — which
 * is the whole point of a focus command.
 */
async function windowRefFor(workspaceRef: string): Promise<string | undefined> {
    try {
        const identify = await runCmuxJSON<IdentifyResponse>(["identify", "--workspace", workspaceRef]);
        return identify.caller?.window_ref;
    } catch (err) {
        log.debug({ err, workspaceRef }, "could not resolve the owning window; focusing without it");
        return undefined;
    }
}

/** Raise the cmux app itself, so a focused pane is actually on screen. */
async function activateApp(identity?: IdentifyResponse): Promise<boolean> {
    if (process.platform !== "darwin") {
        log.debug({ platform: process.platform }, "app activation is macOS-only; skipped");
        return false;
    }

    try {
        const identify = identity ?? (await runCmuxJSON<IdentifyResponse>(["identify"]));
        const bundleId = identify.bundle_identifier;

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
const SESSION_ID_QUERY = /^[0-9a-f-]{8,}$/i;

export async function focusCommand(query: string, opts: FocusOptions, deps: FocusCommandDeps = {}): Promise<void> {
    const prof = profiler.scope("cmux-focus");
    // Commander passes the Command as the third argument. Only tests inject fetchSnapshot.
    // Session-id queries match the ` · 8b6e69bf` tab title restore stamps. Skip
    // capture-pane so focus does not dump every terminal.
    const fetchSnapshot =
        typeof deps.fetchSnapshot === "function"
            ? deps.fetchSnapshot
            : () =>
                  fetchCmuxLiveSnapshot({
                      previews: SESSION_ID_QUERY.test(query.trim()) ? "none" : "selected",
                  });
    const [snapshot, identity] = await Promise.all([
        prof.measureAsync("snapshot", () => fetchSnapshot()),
        prof.measureAsync("identify", () => identifyCmux()),
    ]);

    if (!snapshot.available) {
        out.error(pc.red(`cmux is not reachable${snapshot.error ? `: ${snapshot.error}` : "."}`));
        out.printlnErr(pc.dim("  Start cmux, then run this again."));
        process.exit(1);
    }

    const excludePaneId = opts.includeSelf ? undefined : identity?.caller?.pane_ref;
    const targets = findFocusTargets(snapshot, query, { excludePaneId });
    log.debug({ query, panes: snapshot.panes.length, matches: targets.length, excludePaneId }, "focus match");

    if (targets.length === 0) {
        if (opts.json) {
            // Same failure as the human path below, so it has to carry the same exit code.
            // `{ focused: null }` on exit 0 reads as success to anything scripting this.
            process.exitCode = 1;
            out.result(SafeJSON.stringify({ query, focused: null, matches: [] }, null, 2));
            return;
        }

        out.error(pc.red(`No cmux pane matches "${query}".`));
        out.printlnErr(pc.dim(`  Searched ${snapshot.panes.length} pane(s) across ${snapshot.workspaces.length}.`));
        out.printlnErr(
            pc.dim(
                `  If the session is not open anywhere, reopen it: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "restore"] })}`
            )
        );
        process.exit(1);
    }

    let target = targets[0];

    if (!isUnambiguous(targets) && !opts.first) {
        if (opts.json) {
            // Nothing was focused, and `--json` has no TTY to disambiguate on, so this is
            // the same failure the non-TTY human path exits 1 for.
            process.exitCode = 1;
            out.result(SafeJSON.stringify({ query, focused: null, ambiguous: true, matches: targets }, null, 2));
            return;
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
            return;
        }

        target = picked;
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

    const windowRef = target.windowRef ?? (await windowRefFor(target.workspaceId));

    if (windowRef) {
        await runCmuxOk(["focus-window", "--window", windowRef]);
    }

    await focusCmuxPane({ workspaceId: target.workspaceId, paneId: target.paneId });

    if (target.surfaceId) {
        // The match came from a background tab. Without this the pane is focused and the
        // command claims success while the user still looks at a different surface.
        try {
            await focusCmuxSurface({ surfaceId: target.surfaceId });
        } catch (err) {
            log.warn({ err, surfaceId: target.surfaceId }, "could not focus the matched surface");
            out.printlnErr(pc.dim("  The pane is focused, but its matching tab could not be raised."));
        }
    }

    const activated = opts.activate === false ? false : await activateApp(identity);

    if (opts.json) {
        out.result(SafeJSON.stringify({ query, focused: target, windowRef, activated }, null, 2));
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
