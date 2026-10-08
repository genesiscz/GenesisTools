import type { FocusTarget } from "@app/claude/lib/cmux/focus";
import { findSessionTargets, type ResolveDeps, retryAfterStaleRefs } from "@app/claude/lib/cmux/resolve";
import { suggestCommand } from "@genesiscz/utils/cli";
import { type CmuxRunResult, runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { deliverySurfaceId, refuseAmbiguous, type SendOptions } from "./send";

const { log } = logger.scoped("claude-cmux-read");

export interface ReadOptions {
    lines?: string;
    scrollback?: boolean;
    first?: boolean;
    includeSelf?: boolean;
}

export type ReadRunner = (args: string[]) => Promise<CmuxRunResult>;

export function parseReadLines(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw.trim();

    if (!/^[1-9][0-9]*$/.test(trimmed)) {
        throw new Error(`--lines must be a positive integer (got ${raw})`);
    }

    return Number(trimmed);
}

export function capturePaneArgs(
    workspace: string,
    surface: string,
    opts: { lines?: number; scrollback?: boolean }
): string[] {
    const args = ["capture-pane", "--workspace", workspace, "--surface", surface];

    if (opts.scrollback) {
        args.push("--scrollback");
    }

    if (opts.lines !== undefined) {
        args.push("--lines", String(opts.lines));
    }

    return args;
}

async function capturePane(
    workspace: string,
    surface: string,
    opts: { lines?: number; scrollback?: boolean },
    run: ReadRunner
): Promise<string> {
    const result = await run(capturePaneArgs(workspace, surface, opts));

    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `cmux capture-pane failed (${result.code})`);
    }

    return result.stdout;
}

interface Located {
    target: FocusTarget;
    surfaceId: string;
    source: string;
}

/**
 * The pane `tools claude cmux send` would type into. Prints the same miss and ambiguity errors.
 * Returns null when the command must stop.
 */
async function locatePane(query: string, opts: ReadOptions, deps: ResolveDeps): Promise<Located | null> {
    const queryTrim = query.trim();
    const sendOpts: SendOptions = { first: opts.first, includeSelf: opts.includeSelf };
    let result = await findSessionTargets(queryTrim, { includeSelf: opts.includeSelf, deps });

    if (result.unavailable) {
        out.error(pc.red(`cmux is not reachable: ${result.unavailable}`));
        process.exit(1);
    }

    if (result.targets.length === 0) {
        process.exitCode = 1;
        out.error(pc.red(`No cmux pane matches "${queryTrim}".`));
        const reopen = suggestCommand("tools claude", { replaceCommand: ["cmux", "restore"] });
        out.printlnErr(pc.dim(`  If the session is not open anywhere, reopen it: ${reopen}`));
        return null;
    }

    if (refuseAmbiguous(result, queryTrim, sendOpts)) {
        return null;
    }

    let target = result.targets[0];
    let surfaceId = deliverySurfaceId(target, result.snapshot?.panes ?? []);

    if (surfaceId) {
        return { target, surfaceId, source: result.source };
    }

    const retry = await retryAfterStaleRefs(queryTrim, { includeSelf: opts.includeSelf, deps }, async (found) =>
        refuseAmbiguous(found, queryTrim, sendOpts) ? null : found.targets[0]
    );
    result = retry.result;

    if (retry.status === "stopped") {
        return null;
    }

    const fallback = retry.status === "ok" ? retry.target : undefined;
    const fallbackSurface = fallback ? deliverySurfaceId(fallback, result.snapshot?.panes ?? []) : undefined;

    if (!fallback || !fallbackSurface) {
        process.exitCode = 1;
        out.error(pc.red(`Matched "${queryTrim}" but found no live surface to read.`));
        return null;
    }

    target = fallback;
    surfaceId = fallbackSurface;
    return { target, surfaceId, source: result.source };
}

/**
 * Print the pane text for a session, using the same resolution as `tools claude cmux send`.
 * Returns the text, or null when the session could not be resolved (exit code already set).
 */
export async function readSessionText(
    query: string,
    opts: ReadOptions = {},
    deps: ResolveDeps = {},
    run: ReadRunner = runCmux
): Promise<string | null> {
    const lines = parseReadLines(opts.lines);
    const located = await locatePane(query, opts, deps);

    if (!located) {
        return null;
    }

    const captureOpts = { lines, scrollback: opts.scrollback === true };

    try {
        const text = await capturePane(located.target.workspaceId, located.surfaceId, captureOpts, run);
        log.debug(
            { query, workspace: located.target.workspaceId, surface: located.surfaceId, source: located.source },
            "captured cmux pane"
        );
        return text;
    } catch (error) {
        if (located.source !== "recorded") {
            throw error;
        }

        log.debug({ error }, "recorded cmux refs are stale; retrying with the text matcher");
    }

    const queryTrim = query.trim();
    const sendOpts: SendOptions = { first: opts.first, includeSelf: opts.includeSelf };
    const retry = await retryAfterStaleRefs(queryTrim, { includeSelf: opts.includeSelf, deps }, async (found) =>
        refuseAmbiguous(found, queryTrim, sendOpts) ? null : found.targets[0]
    );

    if (retry.status === "stopped") {
        return null;
    }

    const fallback = retry.status === "ok" ? retry.target : undefined;
    const fallbackSurface = fallback ? deliverySurfaceId(fallback, retry.result.snapshot?.panes ?? []) : undefined;

    if (!fallback || !fallbackSurface) {
        process.exitCode = 1;
        out.error(pc.red(`Matched "${queryTrim}" but found no live surface to read.`));
        return null;
    }

    return capturePane(fallback.workspaceId, fallbackSurface, captureOpts, run);
}
