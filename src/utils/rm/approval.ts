import { isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { RmCaller } from "./rules";

export type ApprovalVia = "tty" | "dialog";

export interface ApprovalOutcome {
    approved: boolean;
    via: ApprovalVia | "none";
    detail: string;
}

export interface ApprovalPrompt {
    title: string;
    lines: string[];
    /** What a person types on a terminal to confirm (the request id, or `delete`). */
    code: string;
    caller: RmCaller;
}

export interface ApprovalDeps {
    interactive: () => boolean;
    platform: NodeJS.Platform;
    typed: (prompt: ApprovalPrompt) => Promise<boolean>;
    dialog: (prompt: ApprovalPrompt) => boolean;
}

const MAX_DIALOG_LINES = 15;

async function askTyped(prompt: ApprovalPrompt): Promise<boolean> {
    p.note(prompt.lines.join("\n"), prompt.title);

    try {
        const answer = await p.text({ message: `Type ${prompt.code} to confirm, anything else cancels` });
        return answer.trim() === prompt.code;
    } catch (error) {
        logger.debug({ error }, "rm: confirmation cancelled");
        return false;
    }
}

function appleScriptString(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function showDialog(prompt: ApprovalPrompt): boolean {
    const shown = prompt.lines.slice(0, MAX_DIALOG_LINES);

    if (prompt.lines.length > MAX_DIALOG_LINES) {
        shown.push(`…and ${prompt.lines.length - MAX_DIALOG_LINES} more`);
    }

    const body = `${prompt.title}\n\n${shown.join("\n")}`;
    const script =
        `display dialog ${appleScriptString(body)} with title "Confirm deletion" ` +
        `buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 600`;
    const proc = Bun.spawnSync(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const answer = new TextDecoder().decode(proc.stdout);
    logger.debug({ exitCode: proc.exitCode, answer: answer.trim() }, "rm: approval dialog answered");
    return proc.exitCode === 0 && answer.includes("button returned:Approve") && !answer.includes("gave up:true");
}

const DEFAULT_DEPS: ApprovalDeps = {
    interactive: isInteractive,
    platform: process.platform,
    typed: askTyped,
    dialog: showDialog,
};

/**
 * Asks a person, never an agent. Outside an agent on a terminal the person types the code. Inside an agent (or
 * with no terminal) a macOS dialog asks instead: an agent can start it but cannot press Approve, and a terminal
 * an agent fakes (`script`, a pty) still lands on the dialog. With neither, the answer is no.
 */
export async function confirmByPerson(
    prompt: ApprovalPrompt,
    deps: ApprovalDeps = DEFAULT_DEPS
): Promise<ApprovalOutcome> {
    if (!prompt.caller.isInAgent && deps.interactive()) {
        const approved = await deps.typed(prompt);
        return { approved, via: "tty", detail: approved ? "typed the code" : "the code was not typed" };
    }

    if (deps.platform === "darwin") {
        const approved = deps.dialog(prompt);
        return {
            approved,
            via: "dialog",
            detail: approved ? "pressed Approve" : "the dialog was cancelled or timed out",
        };
    }

    return { approved: false, via: "none", detail: "a person must confirm on a terminal (or the macOS dialog)" };
}
