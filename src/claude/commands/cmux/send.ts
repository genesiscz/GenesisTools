import { describeMatch, type FocusTarget, isUnambiguous } from "@app/claude/lib/cmux/focus";
import {
    findSessionTargets,
    identifiesExactSession,
    type ResolveDeps,
    retryAfterStaleRefs,
    SOFT_SOURCES,
} from "@app/claude/lib/cmux/resolve";
import { suggestCommand } from "@genesiscz/utils/cli";
import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";

const { log } = logger.scoped("claude-cmux-send");

export interface SendOptions {
    first?: boolean;
    includeSelf?: boolean;
    enter?: boolean;
    paste?: boolean;
    exactSession?: boolean;
    enterDelay?: string;
    dryRun?: boolean;
    json?: boolean;
    /** Seconds. The whole send (lookup, text, Enter) must finish within it. */
    timeout?: string;
}

/** Exit status of a send that ran past `--timeout`; 124 is what coreutils `timeout` uses. */
export const SEND_TIMEOUT_EXIT = 124;

/**
 * `sendCommand` bounded by `--timeout`. Without it, a cmux socket that stops answering, or a lookup that
 * captures slow panes, holds a bot that drives panes for as long as it likes. On expiry the answer is
 * "timeout"; the text may already be typed with Enter still owed, so the door says to look at the pane.
 */
export async function sendWithin(
    query: string,
    text: string,
    opts: SendOptions,
    deps: SendCommandDeps = {}
): Promise<boolean | "timeout"> {
    if (opts.timeout === undefined) {
        return sendCommand(query, text, opts, deps);
    }

    const seconds = Number(opts.timeout);

    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`--timeout must be a positive number of seconds (got ${opts.timeout})`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), seconds * 1000);
    });

    try {
        return await Promise.race([sendCommand(query, text, opts, deps), expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** The `send` door shared by `tools claude cmux send` and `tools <agent> cmux send`. */
export async function sendDoor(
    query: string,
    text: string,
    opts: SendOptions,
    deps: SendCommandDeps = {}
): Promise<void> {
    const outcome = await sendWithin(query, text, opts, deps);

    if (outcome !== "timeout") {
        return;
    }

    if (opts.json) {
        out.result({ sent: false, reason: "timeout", query, timeoutSeconds: Number(opts.timeout) });
    }

    out.error(
        pc.red(
            `send to "${query}" did not finish within ${opts.timeout} s. The text may be typed without Enter; check the pane.`
        )
    );
    await out.flush();
    // The send still runs in the background and would keep the process alive past the deadline.
    process.exit(SEND_TIMEOUT_EXIT);
}

export type SendCommandDeps = ResolveDeps;

/**
 * The surface the text must go to. A title/alias/recorded match names its tab
 * already; a pane-scope match does not, so fall back to the pane's selected
 * tab — `cmux send` without a surface only works inside cmux ($CMUX_SURFACE_ID).
 */
export function deliverySurfaceId(
    target: FocusTarget,
    panes: { id: string; selectedSurfaceRef?: string; surfaces: { id: string; selected: boolean }[] }[]
): string | undefined {
    if (target.surfaceId) {
        return target.surfaceId;
    }

    const pane = panes.find((candidate) => candidate.id === target.paneId);

    return pane?.selectedSurfaceRef ?? pane?.surfaces.find((candidate) => candidate.selected)?.id;
}

interface Delivery {
    target: FocusTarget;
    surfaceId: string;
    text: string;
    enter: boolean;
    enterDelayMs: number;
    paste: boolean;
}

async function deliver({ target, surfaceId, text, enter, enterDelayMs, paste }: Delivery) {
    const where = surfaceTargetArgs(surfaceId, target.workspaceId);
    if (paste) {
        await runCmuxOk(["paste", ...where, ...(enter ? ["--submit"] : []), "--", text]);
        return;
    }

    await runCmuxOk(["send", ...where, "--", text]);

    if (enter) {
        await Bun.sleep(enterDelayMs);
        await runCmuxOk(["send-key", ...where, "enter"]);
    }
}

/**
 * The no-wrong-pane guard, shared by the first pass and the stale-ref fallback.
 * Returns true when the caller must stop.
 *
 * A soft match only proves "a pane in that repo" or "a pane that mentions this
 * id", so with several candidates `--first` would type into whichever sorted
 * highest. Typing into the wrong agent session is worse than not typing at all.
 */
export function refuseAmbiguous(
    result: Awaited<ReturnType<typeof findSessionTargets>>,
    queryTrim: string,
    opts: SendOptions
): boolean {
    // `--exact-session` checks the evidence each pane matched on, not only the stage that found it:
    // a title or capture stage also returns panes that merely print the id or share a topic title.
    const weak = SOFT_SOURCES.has(result.source) && result.targets.length > 1;
    if (weak || (opts.exactSession && !identifiesExactSession(result))) {
        process.exitCode = 1;

        if (opts.json) {
            out.result(
                SafeJSON.stringify(
                    { query: queryTrim, sent: false, ambiguous: true, source: result.source, matches: result.targets },
                    null,
                    2
                )
            );
            return true;
        }

        const evidence = result.targets[0] ? describeMatch(result.targets[0]) : result.source;
        out.error(
            pc.red(
                `"${queryTrim}" only matched weakly (${result.source}, ${evidence}); this does not identify the recipient session.`
            )
        );
        out.printlnErr(pc.dim("  Send a prompt in that session once so the hook can record its pane, then retry."));
        return true;
    }

    if (!isUnambiguous(result.targets) && !opts.first) {
        process.exitCode = 1;

        if (opts.json) {
            out.result(
                SafeJSON.stringify({ query: queryTrim, sent: false, ambiguous: true, matches: result.targets }, null, 2)
            );
            return true;
        }

        out.error(pc.red(`Several panes match "${queryTrim}" — pass --first to take the best one.`));
        return true;
    }

    return false;
}

/**
 * Type text into the pane a session is running in, then press Enter.
 *
 * The wakeup path for a session that is about to lose its prompt cache: the
 * Genesis usage monitor's notification buttons run exactly this command, and it
 * works from anywhere — the caller does not have to live inside cmux.
 *
 * Resolution is staged (hook journal → tab titles → pane captures); recorded
 * refs that went stale (cmux restarted) fail fast and fall back to the matcher.
 */
export async function sendCommand(
    query: string,
    text: string,
    opts: SendOptions,
    deps: SendCommandDeps = {}
): Promise<boolean> {
    const queryTrim = query.trim();
    const enter = opts.enter !== false;
    const enterDelayMs = Number(opts.enterDelay ?? "500");

    if (!Number.isFinite(enterDelayMs) || enterDelayMs < 0) {
        throw new Error(`--enter-delay must be a non-negative number (got ${opts.enterDelay})`);
    }

    let result = await findSessionTargets(queryTrim, { includeSelf: opts.includeSelf, deps });

    if (result.unavailable) {
        out.error(pc.red(`cmux is not reachable: ${result.unavailable}`));
        process.exit(1);
    }

    if (result.targets.length === 0) {
        process.exitCode = 1;

        if (opts.json) {
            out.result(SafeJSON.stringify({ query: queryTrim, sent: false, matches: [] }, null, 2));
            return false;
        }

        out.error(pc.red(`No cmux pane matches "${queryTrim}".`));
        out.printlnErr(
            pc.dim(
                `  If the session is not open anywhere, reopen it: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "restore"] })}`
            )
        );
        return false;
    }

    if (refuseAmbiguous(result, queryTrim, opts)) {
        return false;
    }

    let target = result.targets[0];
    let surfaceId = deliverySurfaceId(target, result.snapshot?.panes ?? []);

    if (opts.dryRun) {
        const plan = { query: queryTrim, wouldSendTo: target, surfaceId, text, enter, source: result.source };

        if (opts.json) {
            out.result(SafeJSON.stringify(plan, null, 2));
            return false;
        }

        out.printlnErr(
            `${pc.yellow("dry run")} would send to ${pc.bold(target.workspaceName)} ${pc.dim(target.paneId)} ` +
                pc.dim(`${surfaceId ?? "?"} (matched on ${describeMatch(target)})`)
        );
        return false;
    }

    if (surfaceId) {
        try {
            await deliver({ target, surfaceId, text, enter, enterDelayMs, paste: opts.paste === true });
            report({ opts, query: queryTrim, target, surfaceId, enter, source: result.source });
            return true;
        } catch (err) {
            if (result.source !== "recorded" || opts.paste) {
                throw err;
            }
            // Recorded refs outlived their pane (cmux restart). Fall back to the matcher.
            log.debug({ err }, "recorded cmux refs are stale; retrying with the text matcher");
        }
    }

    // The stale-ref fallback re-runs the matcher, so it can land on several
    // panes just like the first pass. `retryAfterStaleRefs` is what makes the
    // guard unskippable: without it this typed into targets[0] with no --first,
    // which is the exact case the guard exists to prevent.
    const retry = await retryAfterStaleRefs(queryTrim, { includeSelf: opts.includeSelf, deps }, async (found) =>
        refuseAmbiguous(found, queryTrim, opts) ? null : found.targets[0]
    );
    result = retry.result;

    if (retry.status === "stopped") {
        return false;
    }

    const fallback = retry.status === "ok" ? retry.target : undefined;
    const fallbackSurface = fallback ? deliverySurfaceId(fallback, result.snapshot?.panes ?? []) : undefined;

    if (!fallback || !fallbackSurface) {
        process.exitCode = 1;

        if (opts.json) {
            out.result(SafeJSON.stringify({ query: queryTrim, sent: false, matches: result.targets }, null, 2));
            return false;
        }

        out.error(pc.red(`Matched "${queryTrim}" but found no live surface to type into.`));
        return false;
    }

    target = fallback;
    surfaceId = fallbackSurface;
    await deliver({ target, surfaceId, text, enter, enterDelayMs, paste: opts.paste === true });
    report({ opts, query: queryTrim, target, surfaceId, enter, source: result.source });
    return true;
}

interface SendReport {
    opts: SendOptions;
    query: string;
    target: FocusTarget;
    surfaceId: string;
    enter: boolean;
    source: string;
}

function report({ opts, query, target, surfaceId, enter, source }: SendReport): void {
    if (opts.json) {
        out.result(SafeJSON.stringify({ query, sent: true, target, surfaceId, enter, source }, null, 2));
        return;
    }

    out.printlnErr(
        `${pc.green("√")} sent to ${pc.bold(target.workspaceName)} ${pc.dim(target.paneId)} ` +
            pc.dim(`${surfaceId} (matched on ${describeMatch(target)})`)
    );
}
