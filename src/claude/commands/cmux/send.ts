import { describeMatch } from "@app/claude/lib/cmux/focus";
import {
    ambiguousMatch,
    type PaneSendOutcome,
    paneSendReceipt,
    type SendCommandDeps,
    type SendOptions,
    sendToSessionPane,
} from "@app/claude/lib/cmux/pane-send";
import type { SessionTargetsResult } from "@app/claude/lib/cmux/resolve";
import { suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export { deliverySurfaceId, type SendCommandDeps, type SendOptions } from "@app/claude/lib/cmux/pane-send";

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
    deps: SendCommandDeps = {},
    run: () => Promise<boolean> = () => sendCommand(query, text, opts, deps)
): Promise<boolean | "timeout"> {
    if (opts.timeout === undefined) {
        return run();
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
        return await Promise.race([run(), expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** The `send` door shared by `tools claude cmux send` and `tools <agent> cmux send`. */
export async function sendDoor(
    query: string,
    text: string,
    opts: SendOptions,
    deps: SendCommandDeps = {},
    run?: () => Promise<boolean>
): Promise<void> {
    const outcome = await sendWithin(query, text, opts, deps, run);

    if (outcome !== "timeout") {
        return;
    }

    if (opts.json) {
        // `unconfirmed`: the text may be typed already with Enter still owed, so no caller may read this as a
        // refusal before input (readPaneReceipt).
        out.result({ sent: false, unconfirmed: true, reason: "timeout", query, timeoutSeconds: Number(opts.timeout) });
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

/**
 * cmux is not reachable: exit 1 at once. The `--json` receipt still goes to stdout (`readPaneReceipt` reads it as a
 * refusal with its reason, not an unreadable answer), and the output is flushed before the exit.
 */
async function exitUnreachable(
    outcome: Extract<PaneSendOutcome, { kind: "unavailable" }>,
    opts: SendOptions
): Promise<never> {
    if (opts.json) {
        out.result(SafeJSON.stringify(paneSendReceipt(outcome), null, 2));
    }

    out.error(pc.red(`cmux is not reachable: ${outcome.reason}`));
    await out.flush();
    process.exit(1);
}

/**
 * The CLI face of a pane send: `--json` prints the receipt (`paneSendReceipt`), else one human line and its hints.
 * Every outcome but a typed send sets exit status 1; a dry run sets none.
 */
function printPaneSend(outcome: Exclude<PaneSendOutcome, { kind: "unavailable" }>, opts: SendOptions): boolean {
    if (outcome.kind !== "typed" && outcome.kind !== "dry-run") {
        process.exitCode = 1;
    }

    if (opts.json) {
        out.result(SafeJSON.stringify(paneSendReceipt(outcome), null, 2));
        return outcome.kind === "typed";
    }

    switch (outcome.kind) {
        case "typed":
            out.printlnErr(
                `${pc.green("✔")} sent to ${pc.bold(outcome.target.workspaceName)} ${pc.dim(outcome.target.paneId)} ` +
                    pc.dim(`${outcome.surfaceId} (matched on ${describeMatch(outcome.target)})`)
            );
            return true;
        case "dialog":
            out.error(pc.red(outcome.reason.replace("pass force", "pass --force")));
            return false;
        case "ambiguous":
        case "hidden":
            printAmbiguous(outcome);
            return false;
        case "no-match":
            out.error(pc.red(`No cmux pane matches "${outcome.query}".`));

            if (outcome.tmuxHint) {
                out.printlnErr(pc.dim(`  ${outcome.tmuxHint}`));
            }

            out.printlnErr(
                pc.dim(
                    `  If the session is not open anywhere, reopen it: ${suggestCommand("tools claude", { replaceCommand: ["cmux", "restore"] })}`
                )
            );
            return false;
        case "no-surface":
            out.error(pc.red(`Matched "${outcome.query}" but found no live surface to type into.`));
            return false;
        case "dry-run":
            out.printlnErr(
                `${pc.yellow("dry run")} would send to ${pc.bold(outcome.target.workspaceName)} ${pc.dim(outcome.target.paneId)} ` +
                    pc.dim(`${outcome.surfaceId ?? "?"} (matched on ${describeMatch(outcome.target)})`)
            );
            return false;
        case "option-refused":
            out.error(pc.red(`Nothing was pressed: ${outcome.reason}.`));
            return false;
        case "option-pressed":
            out.printlnErr(
                `Option key sent to ${outcome.target.workspaceName}; submission is unconfirmed. Check the dialog before retrying.`
            );
            return false;
        default:
            return outcome satisfies never;
    }
}

function printAmbiguous(outcome: Extract<PaneSendOutcome, { kind: "ambiguous" | "hidden" }>): void {
    if (outcome.kind === "hidden") {
        out.error(
            pc.red(
                `"${outcome.query}" runs in tmux pane ${outcome.hidden.tmux?.pane} of ${outcome.hidden.tmux?.session}, and the tmux client in ${outcome.hidden.paneId} shows another pane.`
            )
        );
        out.printlnErr(pc.dim("  Switch that tmux session to the session's pane, then retry."));
        return;
    }

    if (outcome.weak) {
        out.error(
            pc.red(
                `"${outcome.query}" only matched weakly (${outcome.weak.source}, ${outcome.weak.evidence}); this does not identify the recipient session.`
            )
        );
        out.printlnErr(pc.dim("  Send a prompt in that session once so the hook can record its pane, then retry."));
        return;
    }

    out.error(pc.red(`Several panes match "${outcome.query}" — pass --first to take the best one.`));
}

/**
 * The no-wrong-pane guard for a CLI door that resolved the panes itself (`tools claude cmux read`): prints the
 * refusal and returns true when the caller must stop.
 */
export function refuseAmbiguous(result: SessionTargetsResult, queryTrim: string, opts: SendOptions): boolean {
    const refused = ambiguousMatch(result, queryTrim, opts);

    if (!refused) {
        return false;
    }

    printPaneSend(refused, opts);
    return true;
}

/**
 * Type text into the pane a session is running in, then press Enter.
 *
 * The wakeup path for a session that is about to lose its prompt cache: the
 * Genesis usage monitor's notification buttons run exactly this command, and it
 * works from anywhere — the caller does not have to live inside cmux.
 */
export async function sendCommand(
    query: string,
    text: string,
    opts: SendOptions,
    deps: SendCommandDeps = {}
): Promise<boolean> {
    const outcome = await sendToSessionPane(query, text, opts, deps);

    if (outcome.kind === "unavailable") {
        return exitUnreachable(outcome, opts);
    }

    return printPaneSend(outcome, opts);
}
