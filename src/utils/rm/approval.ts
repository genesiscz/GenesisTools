import { isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { type GenesisAppRpcOutcome, genesisAppRpc } from "@genesiscz/utils/macos/genesis-app-rpc";
import * as p from "@genesiscz/utils/prompts/p";
import type { RmApproval } from "./config";
import type { RmCaller } from "./rules";

export type ApprovalVia = "tty" | "dialog" | "touch-id" | "password";

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
    /** The person's `approval` setting; `auto` when not given. */
    approval?: RmApproval;
}

/** The app's window answered (`outcome`), or there is no app that offers it (`missing`). */
export type AppApproval = { kind: "answered"; outcome: ApprovalOutcome } | { kind: "missing"; detail: string };

export interface ApprovalDeps {
    interactive: () => boolean;
    platform: NodeJS.Platform;
    typed: (prompt: ApprovalPrompt) => Promise<boolean>;
    dialog: (prompt: ApprovalPrompt) => boolean;
    app: (prompt: ApprovalPrompt) => Promise<AppApproval>;
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

/** A person reads the window and touches the sensor; the app gives up at 170 s and says why. */
const APP_TIMEOUT_MS = 180_000;

/**
 * The app cannot ask: no bundle (or routing off), a build without `rm.approve`, or something other than the app
 * answered. Only these fall back to the code. A deny, a failed Touch ID and a timeout are answers, never a fallback.
 */
const APP_MISSING_CODES = new Set(["unavailable", "method_unknown", "handshake"]);

interface RmApproveReply {
    decision: string;
    method?: string;
    reason?: string;
}

function isRmApproveReply(value: unknown): value is RmApproveReply {
    return typeof value === "object" && value !== null && "decision" in value && typeof value.decision === "string";
}

function callerLabel(caller: RmCaller): string | undefined {
    if (!caller.isInAgent) {
        return undefined;
    }

    const session = caller.sessionTitle ?? caller.sessionId?.slice(0, 8);
    return session ? `${caller.agent} · ${session}` : caller.agent;
}

/** Only an exact `allow` approves; any other reply, and any failure that is not "no app", is a no. */
export function appApprovalFromReply(outcome: GenesisAppRpcOutcome<RmApproveReply>): AppApproval {
    if (!outcome.ok) {
        if (APP_MISSING_CODES.has(outcome.error.code)) {
            return { kind: "missing", detail: outcome.error.message };
        }

        const detail = `${outcome.error.code}: ${outcome.error.message}`;
        return { kind: "answered", outcome: { approved: false, via: "touch-id", detail } };
    }

    const { decision, method, reason } = outcome.result;

    if (decision !== "allow") {
        return {
            kind: "answered",
            outcome: { approved: false, via: "touch-id", detail: reason || "denied in the approval window" },
        };
    }

    const via = method === "password" ? "password" : "touch-id";
    const detail = via === "password" ? "approved with the account password" : "approved with Touch ID";
    return { kind: "answered", outcome: { approved: true, via, detail } };
}

async function askApp(prompt: ApprovalPrompt): Promise<AppApproval> {
    const outcome = await genesisAppRpc<RmApproveReply>(
        "rm.approve",
        { title: prompt.title, lines: prompt.lines, caller: callerLabel(prompt.caller), folder: process.cwd() },
        { timeoutMs: APP_TIMEOUT_MS, isResult: isRmApproveReply }
    );
    const answer = appApprovalFromReply(outcome);
    logger.debug({ answer }, "rm: approval window answered");
    return answer;
}

const DEFAULT_DEPS: ApprovalDeps = {
    interactive: isInteractive,
    platform: process.platform,
    typed: askTyped,
    dialog: showDialog,
    app: askApp,
};

/**
 * Asks a person, never an agent. With Touch ID allowed (`approval` `auto` or `touch-id`) GenesisTools.app shows the
 * request and confirms with Touch ID: an agent can open the window but cannot touch the sensor. Without the app,
 * `auto` falls back to the code: outside an agent on a terminal the person types it; inside an agent (or with no
 * terminal) a macOS dialog asks instead, since a terminal an agent fakes (`script`, a pty) could type the code.
 * With neither, the answer is no.
 */
export async function confirmByPerson(
    prompt: ApprovalPrompt,
    deps: ApprovalDeps = DEFAULT_DEPS
): Promise<ApprovalOutcome> {
    const approval = prompt.approval ?? "auto";

    if (approval !== "code" && deps.platform === "darwin") {
        const answer = await deps.app(prompt);

        if (answer.kind === "answered") {
            return answer.outcome;
        }

        if (approval === "touch-id") {
            return { approved: false, via: "none", detail: `Touch ID needs GenesisTools.app (${answer.detail})` };
        }

        logger.debug({ detail: answer.detail }, "rm: no Touch ID window, asking for the code");
    }

    if (approval === "touch-id") {
        return { approved: false, via: "none", detail: "Touch ID needs GenesisTools.app on macOS" };
    }

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
