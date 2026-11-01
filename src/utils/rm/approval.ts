import { homedir } from "node:os";
import { harnessLabel, harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { isInteractive } from "@genesiscz/utils/cli";
import { formatBytes } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { type GenesisAppRpcOutcome, genesisAppRpc } from "@genesiscz/utils/macos/genesis-app-rpc";
import * as p from "@genesiscz/utils/prompts/p";
import { type RmApproval, rmConfigPath } from "./config";
import type { FolderStats, ItemGit } from "./item-facts";
import type { RmDisposal, RmRememberChoice } from "./requests";
import type { RmCaller, RmTargetKind } from "./rules";

export type ApprovalVia = "tty" | "dialog" | "touch-id" | "password";

export interface ApprovalOutcome {
    approved: boolean;
    via: ApprovalVia | "none";
    detail: string;
    /** The window's picks; absent for the typed code and the dialog, which answer for all items, trash, once. */
    choices?: ApprovalChoices;
    /** The person pressed Deny in the window (not a timeout, a failed touch or a closed window). */
    deniedByPerson?: boolean;
}

/** What the approval window lets a person pick besides allow or deny. */
export interface ApprovalChoices {
    /** The item paths ticked; null when nothing was unticked (all of them). */
    selected: string[] | null;
    disposal: RmDisposal;
    remember: RmRememberChoice;
    /** The note on a deny; null when none. */
    note: string | null;
}

/** All items, to the trash, just this once: the answer of the typed code and the dialog. */
export const DEFAULT_APPROVAL_CHOICES: ApprovalChoices = {
    selected: null,
    disposal: "trash",
    remember: "once",
    note: null,
};

/** The outcome's picks, or the defaults for a way of asking that has none. */
export function outcomeChoices(outcome: ApprovalOutcome): ApprovalChoices {
    return outcome.choices ?? DEFAULT_APPROVAL_CHOICES;
}

/** One "remember" choice the window offers; the CLI offers only the ones it can carry out for this request. */
export interface ApprovalRememberOption {
    id: RmRememberChoice;
    title: string;
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
    /** What git knows about the path: its repository, its state and, when tracked, its last commit. */
    git?: ItemGit;
    /** A folder's file count and newest change, from a capped walk. */
    folderStats?: FolderStats;
    /** Other pending requests naming the same path; an approval decides them too. */
    alsoIn?: string[];
    /** Its size is still being measured: the window shows "Measuring…" until an update brings it. */
    measuring?: boolean;
}

/** A change to one row after the window opened: its size once measured, its git facts once probed. */
export interface ApprovalItemUpdate {
    /** The row's `path`. */
    path: string;
    bytes?: number;
    empty?: boolean;
    folderStats?: FolderStats;
    git?: ItemGit;
    /** False once the row's size is in, or cannot be measured. */
    measuring?: boolean;
}

/**
 * The row changes that arrive after the window opened, in the order they finish. Every reader gets all of them from
 * the start, so a window that is asked again (its process ended) still shows every size.
 */
export class ApprovalUpdates {
    private readonly seen: ApprovalItemUpdate[] = [];
    private waiting: Array<() => void> = [];
    private closed = false;

    push(update: ApprovalItemUpdate): void {
        if (this.closed) {
            return;
        }

        this.seen.push(update);
        this.wakeReaders();
    }

    /** No more updates come; readers end after the last one. */
    close(): void {
        this.closed = true;
        this.wakeReaders();
    }

    async *read(): AsyncGenerator<ApprovalItemUpdate> {
        let next = 0;

        while (true) {
            while (next < this.seen.length) {
                const update = this.seen[next++];

                if (update) {
                    yield update;
                }
            }

            if (this.closed) {
                return;
            }

            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
    }

    private wakeReaders(): void {
        const waiting = this.waiting;
        this.waiting = [];

        for (const wake of waiting) {
            wake();
        }
    }
}

/** The agent that asked, as the window names it. */
export interface ApprovalAsker {
    /** The agent's display name, e.g. "Claude Code". */
    agent: string;
    session?: string;
    project?: string;
    branch?: string;
    /** The session's id, for links into the hub and the terminal. */
    sessionId?: string;
    /** The history provider of the session (`claude`, `codex`, `grok`). */
    provider?: string;
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
    /** When the agent asked (the request's `createdAt`). */
    askedAt?: string;
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
    /** The "remember" choices this request can carry out; absent: the window offers none. */
    remember?: ApprovalRememberOption[];
    /** Row changes measured after the window opened (`request` rows marked `measuring`); absent: rows are final. */
    updates?: ApprovalUpdates;
    /**
     * `ask`: an agent opened this prompt (`tools rm ask`). The window then arms Touch ID only after the person clicks,
     * so a touch meant for another prompt never approves it.
     */
    openedBy?: "ask";
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

/** How long the typed code waits for the sizes before it asks without the rest. */
export const TYPED_SIZES_WAIT_MS = 30_000;

/**
 * On a terminal the sizes print under the note as they are measured, before the code is asked for. A walk that takes
 * longer than `timeoutMs` does not hold the prompt back: the code is asked for without the sizes still missing, and
 * the walk stops once the person answered (the caller aborts it).
 */
export async function printApprovalUpdates(
    updates: ApprovalUpdates,
    options: { timeoutMs?: number } = {}
): Promise<"complete" | "timeout"> {
    const timeoutMs = options.timeoutMs ?? TYPED_SIZES_WAIT_MS;
    const reader = updates.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
        while (true) {
            const next = await Promise.race([reader.next(), expired]);

            if (next === "timeout") {
                out.println(
                    `  Some sizes are still measured after ${Math.round(timeoutMs / 1000)} s; asking without them.`
                );
                void reader.return(undefined);
                return "timeout";
            }

            if (next.done) {
                return "complete";
            }

            if (next.value.bytes !== undefined) {
                out.println(`  ${next.value.path}  ${formatBytes(next.value.bytes)}`);
            }
        }
    } finally {
        clearTimeout(timer);
    }
}

async function askTyped(prompt: ApprovalPrompt): Promise<boolean> {
    p.note(prompt.lines.join("\n"), prompt.title);

    if (prompt.updates) {
        await printApprovalUpdates(prompt.updates);
    }

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

/** Shows every line of `prompt`; `confirmByPerson` never sends one longer than MAX_DIALOG_LINES. */
function showDialog(prompt: ApprovalPrompt): boolean {
    const body = `${prompt.title}\n\n${prompt.lines.join("\n")}`;
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
    selected?: unknown;
    disposal?: unknown;
    remember?: unknown;
    note?: unknown;
}

const REMEMBER_CHOICES: readonly RmRememberChoice[] = ["once", "session", "folder"];

function isRememberChoice(value: unknown): value is RmRememberChoice {
    return REMEMBER_CHOICES.some((choice) => choice === value);
}

/** The window's picks from its reply; a missing or unknown value is the default (all, trash, once, no note). */
export function replyChoices(reply: RmApproveReply): ApprovalChoices {
    const note = typeof reply.note === "string" ? reply.note.trim() : "";
    return {
        selected: Array.isArray(reply.selected)
            ? reply.selected.filter((path: unknown): path is string => typeof path === "string")
            : null,
        disposal: reply.disposal === "permanent" ? "permanent" : "trash",
        remember: isRememberChoice(reply.remember) ? reply.remember : "once",
        note: note || null,
    };
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

/** Runtime agents that are not harnesses; a harness's name comes from its driver. */
const OTHER_AGENT_NAMES: Record<string, string> = {
    cursor: "Cursor",
    gemini: "Gemini",
};

/** The agent's name as a person reads it: "Claude Code" for `claude-code`; an unknown one keeps its id. */
export function agentDisplayName(agent: string): string {
    const harness = harnessOfRuntimeAgent(agent);
    return harness ? harnessLabel(harness) : (OTHER_AGENT_NAMES[agent] ?? agent);
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
        sessionId: caller.sessionId ?? undefined,
        provider: historyProvider(caller),
    };
}

/** The provider the session's transcript belongs to: the anchor's when it has one, else the agent's own name. */
function historyProvider(caller: RmCaller): string {
    const anchor = caller.transcriptAnchor;

    if (anchor && "provider" in anchor && anchor.provider) {
        return anchor.provider;
    }

    return harnessOfRuntimeAgent(caller.agent) ?? caller.agent;
}

/**
 * The remember choices a delete request can carry out: "this session, this folder" needs the asker's session id;
 * a root request (it is the trust itself) and a person's own run offer none.
 */
export function rememberOptions(kind: "delete" | "root", caller: RmCaller | null): ApprovalRememberOption[] {
    if (kind !== "delete" || !caller?.isInAgent) {
        return [];
    }

    const options: ApprovalRememberOption[] = [{ id: "once", title: "Just this once" }];

    if (caller.sessionId) {
        options.push({ id: "session", title: "This session, this folder" });
    }

    options.push({ id: "folder", title: "Always for this folder" });
    return options;
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

    // A request saved before the counts were worded reads "file(s)".
    const untracked = /^(\d+) untracked files? ?(?:\(s\))? git does not ignore in (.+): may be new work$/.exec(reason);

    if (rule === "git-untracked" && untracked) {
        const [, count = "0", tree = ""] = untracked;
        return `Holds ${countOf(count, "file", "files")} git does not track in ${tildePath(tree, home)}, which may be new work`;
    }

    const tracked = /^(\d+) files? ?(?:\(s\))? tracked by git in (.+?):/.exec(reason);

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

    if (prompt.remember && prompt.remember.length > 0) {
        params.remember = prompt.remember;
    }

    // The window reads `rm.item` lines from its stdin until EOF; without this flag it never reads stdin.
    if (prompt.updates) {
        params.live = true;
    }

    // An agent opened it: the sensor listens only after the person clicks Approve with Touch ID.
    if (prompt.openedBy === "ask") {
        params.arm = "click";
    }

    return params;
}

/** The `rm.item` lines the window reads from its stdin, one per row change. */
async function* updateLines(updates: ApprovalUpdates): AsyncGenerator<Record<string, unknown>> {
    for await (const update of updates.read()) {
        yield { method: "rm.item", params: update };
    }
}

/** The window's give-up reply ("no answer within 170s") is a deny no person pressed. */
const NO_ANSWER = /^no answer\b/;

function isPersonsDeny(decision: string, reason: string | undefined): boolean {
    return decision === "deny" && !NO_ANSWER.test(reason ?? "");
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
    const choices = replyChoices(outcome.result);

    if (decision !== "allow") {
        const detail = reason || "denied in the approval window";
        return {
            kind: "answered",
            outcome: {
                approved: false,
                via: "touch-id",
                detail,
                choices,
                deniedByPerson: isPersonsDeny(decision, reason),
            },
        };
    }

    const via = method === "password" ? "password" : "touch-id";
    const detail = via === "password" ? "approved with the account password" : "approved with Touch ID";
    return { kind: "answered", outcome: { approved: true, via, detail, choices } };
}

async function askApp(prompt: ApprovalPrompt): Promise<AppApproval> {
    const outcome = await genesisAppRpc<RmApproveReply>("rm.approve", appApproveParams(prompt), {
        timeoutMs: APP_TIMEOUT_MS,
        isResult: isRmApproveReply,
        input: prompt.updates ? updateLines(prompt.updates) : undefined,
    });
    const answer = appApprovalFromReply(outcome);
    logger.debug({ answer }, "rm: approval window answered");
    return answer;
}

export const DEFAULT_APPROVAL_DEPS: ApprovalDeps = {
    interactive: isInteractive,
    platform: process.platform,
    typed: askTyped,
    dialog: showDialog,
    app: askApp,
};

/**
 * Asks a person, never an agent. With Touch ID allowed (`approval` `auto` or `touch-id`) GenesisTools.app shows the
 * request and confirms with Touch ID: an agent can open the window but cannot touch the sensor. Without the app,
 * `auto` asks with the macOS dialog, never the typed code: "not in an agent" is read from environment variables an
 * agent can clear, and a terminal an agent fakes (`script`, a pty) types a code as well as a person. On a platform
 * without the app or the dialog, `auto` refuses, since nothing there proves a person answered. Only `code`, which
 * the person writes into the config file, accepts the typed code on a terminal outside an agent.
 */
export async function confirmByPerson(
    prompt: ApprovalPrompt,
    deps: ApprovalDeps = DEFAULT_APPROVAL_DEPS
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

        logger.debug({ detail: answer.detail }, "rm: no Touch ID window, asking with the dialog");
    }

    if (approval === "touch-id") {
        return { approved: false, via: "none", detail: "Touch ID needs GenesisTools.app on macOS" };
    }

    if (approval === "code" && !prompt.caller.isInAgent && deps.interactive()) {
        const approved = await deps.typed(prompt);
        return { approved, via: "tty", detail: approved ? "typed the code" : "the code was not typed" };
    }

    if (deps.platform === "darwin") {
        // The dialog shows MAX_DIALOG_LINES lines; a longer prompt would let a person approve paths it never showed.
        if (prompt.lines.length > MAX_DIALOG_LINES) {
            return {
                approved: false,
                via: "none",
                detail: `the macOS dialog shows ${MAX_DIALOG_LINES} lines and this needs ${prompt.lines.length}: open GenesisTools.app for the approval window, or type the code on a terminal (the approval setting code)`,
            };
        }

        const approved = deps.dialog(prompt);
        return {
            approved,
            via: "dialog",
            detail: approved ? "pressed Approve" : "the dialog was cancelled or timed out",
        };
    }

    if (approval === "auto") {
        return {
            approved: false,
            via: "none",
            detail: `nothing on ${deps.platform} proves a person answered; to accept a typed code on a terminal, set "approval": "code" in ${rmConfigPath()} yourself`,
        };
    }

    return { approved: false, via: "none", detail: "a person must type the code on a terminal, outside an agent" };
}
