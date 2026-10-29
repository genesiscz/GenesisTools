import { homedir } from "node:os";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { type GenesisAppRpcOutcome, genesisAppRpc } from "@genesiscz/utils/macos/genesis-app-rpc";
import * as p from "@genesiscz/utils/prompts/p";
import type { RmApproval } from "./config";
import type { RmCaller, RmTargetKind } from "./rules";

export type ApprovalVia = "tty" | "dialog" | "touch-id" | "password";

export interface ApprovalOutcome {
    approved: boolean;
    via: ApprovalVia | "none";
    detail: string;
}

/** One path of a request as the approval window shows it: a row with its icon, size and reason. */
export interface ApprovalItem {
    /** Where it was, the path the request names. */
    path: string;
    /** What is there now (`missing` when it is gone). */
    kind: RmTargetKind;
    /** Its allocated size; absent when not measured (a missing path, a root request). */
    bytes?: number;
    /** A folder with nothing in it. */
    empty?: boolean;
    /** Where an aside move put it while it waits; the window reveals this copy. */
    storedAt?: string;
    /** One short sentence for a person: why no rule allowed it. */
    reason: string;
}

/** The agent that asked, as the window names it. */
export interface ApprovalAsker {
    /** The agent's display name, e.g. "Claude Code". */
    agent: string;
    session?: string;
    project?: string;
    branch?: string;
}

/** The request behind a prompt, so the window can show rows instead of the terminal's lines. */
export interface ApprovalRequestInfo {
    /** The request id, or null for a run a person confirms at once (`tools rm <paths>` on a terminal). */
    id: string | null;
    kind: "delete" | "root";
    /** The agent's own words for why. */
    why: string | null;
    /** The folder the request was made in. */
    cwd: string;
    /** Minutes the trash keeps the items before the drain deletes them. */
    graceMinutes?: number;
    asker?: ApprovalAsker;
    items: ApprovalItem[];
}

export interface ApprovalPrompt {
    title: string;
    /** The terminal's lines; also what an app build without `request` support shows. */
    lines: string[];
    /** What a person types on a terminal to confirm (the request id, or `delete`). */
    code: string;
    caller: RmCaller;
    /** The person's `approval` setting; `auto` when not given. */
    approval?: RmApproval;
    /** Set for a delete or root request; settings changes (config, roots, profiles) have only lines. */
    request?: ApprovalRequestInfo;
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

/** `genesisAppRpc`'s detail when the window's process exited before it replied. */
const WINDOW_ENDED = /produced no reply \(exit \d+\)/;

interface RmApproveReply {
    decision: string;
    method?: string;
    reason?: string;
}

function isRmApproveReply(value: unknown): value is RmApproveReply {
    return typeof value === "object" && value !== null && "decision" in value && typeof value.decision === "string";
}

function callerLabel(caller: RmCaller): string | undefined {
    const asker = approvalAsker(caller);

    if (!asker) {
        return undefined;
    }

    const session = asker.session ?? asker.project;
    return session ? `${asker.agent} · ${session}` : asker.agent;
}

const AGENT_NAMES: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    grok: "Grok",
    cursor: "Cursor",
    gemini: "Gemini",
};

/** The agent's name as a person reads it: "Claude Code" for `claude-code`; an unknown one keeps its id. */
export function agentDisplayName(agent: string): string {
    return AGENT_NAMES[agent] ?? agent;
}

/** Who asked, from the request's caller; nothing for a person. */
export function approvalAsker(caller: RmCaller | null | undefined): ApprovalAsker | undefined {
    if (!caller?.isInAgent) {
        return undefined;
    }

    return {
        agent: agentDisplayName(caller.agent),
        session: caller.sessionTitle ?? undefined,
        project: caller.project ?? undefined,
        branch: caller.branch ?? undefined,
    };
}

function tildePath(path: string, home = homedir()): string {
    if (path === home) {
        return "~";
    }

    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function countOf(count: string, one: string, many: string): string {
    return `${count} ${count === "1" ? one : many}`;
}

/**
 * The rule's reason as one short sentence for the approval window. The rule table words its reasons for the
 * terminal ("no rule allows it: a preset, this session's scratch or own files, or a trusted root"); a person deciding
 * in the window needs what that means for this path.
 */
export function approvalItemReason(rule: string, reason: string, home = homedir()): string {
    if (rule === "default") {
        return "Outside this session's scratch, its own files and the trusted folders";
    }

    if (rule === "root") {
        return "Agents may delete anything inside a trusted folder without asking";
    }

    if (rule === "git-history") {
        return "A repository's .git folder: its history and unpushed commits go with it";
    }

    const untracked = /^(\d+) untracked file\(s\) git does not ignore in (.+): may be new work$/.exec(reason);

    if (rule === "git-untracked" && untracked) {
        const [, count = "0", tree = ""] = untracked;
        return `Holds ${countOf(count, "file", "files")} git does not track in ${tildePath(tree, home)}, which may be new work`;
    }

    const tracked = /^(\d+) file\(s\) tracked by git in (.+?):/.exec(reason);

    if (rule === "git-tracked" && tracked) {
        const [, count = "0", tree = ""] = tracked;
        return `Holds ${countOf(count, "file", "files")} tracked by git in ${tildePath(tree, home)}`;
    }

    const nested = /^holds (\d+) git repositor(?:y|ies), e\.g\. (.+)$/.exec(reason);

    if (rule === "nested-repos" && nested) {
        const [, count = "0", example = ""] = nested;
        return `Holds ${countOf(count, "git repository", "git repositories")}, such as ${tildePath(example, home)}`;
    }

    const text = reason.trim().replace(/\.$/, "");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What `rm.approve` sends the app: the terminal's lines for older builds, plus the request's rows when there is one. */
export function appApproveParams(prompt: ApprovalPrompt, cwd = process.cwd()): Record<string, unknown> {
    const params: Record<string, unknown> = {
        title: prompt.title,
        lines: prompt.lines,
        caller: callerLabel(prompt.caller),
        folder: prompt.request?.cwd ?? cwd,
    };

    if (prompt.request) {
        params.request = prompt.request;
    }

    return params;
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
    const outcome = await genesisAppRpc<RmApproveReply>("rm.approve", appApproveParams(prompt), {
        timeoutMs: APP_TIMEOUT_MS,
        isResult: isRmApproveReply,
    });
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
        let answer = await deps.app(prompt);

        // The window opened and its process ended without an answer (a rebuild of the app replaced it): the app is
        // there, so it asks again rather than putting up the text dialog as a second dialog for the same request.
        if (answer.kind === "missing" && WINDOW_ENDED.test(answer.detail)) {
            logger.info({ detail: answer.detail }, "rm: the approval window ended without an answer; asking again");
            answer = await deps.app(prompt);
        }

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
