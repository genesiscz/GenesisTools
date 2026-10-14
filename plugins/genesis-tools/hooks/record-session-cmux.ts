#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAgentProcess, isHeadlessAgent } from "../lib/agent-process";
import { readProcessBasics } from "../lib/process-basics";
import { resumeArgv } from "../lib/resume-argv";
import { accountEnvVarFor, type Harness, harnessFor } from "./harness";

const SafeJSON = JSON;

/**
 * SessionStart + UserPromptSubmit hook: journal which cmux pane this session
 * lives in, so `tools claude cmux focus/send <session-id>` can resolve a fresh,
 * untitled session instantly instead of guessing from tab titles and pane text.
 *
 * 🛑 Codex and Grok run this same plugin hook, and a session started inside a claude pane
 * inherits that pane's CMUX_SURFACE_ID. An untagged record would then put the other agent's
 * id on a claude pane's tty: `assignSessionIds` sees two hints for one tty and drops BOTH,
 * so `tools claude who` goes blank for exactly the pane you were looking at. Every record
 * therefore carries its harness, and the claude reader keeps only claude's.
 *
 * Grok's stdin uses `sessionId`, not Claude's `session_id`. Reading only `session_id`
 * made the hook succeed and write nothing.
 *
 * The launch env carries the stable surface/workspace UUIDs; `cmux identify`
 * adds the pane/window refs a focus needs. Re-recorded on every prompt so a
 * session that moves panes (or a cmux restart) heals on the next message.
 *
 * Silent and never fatal. Claude and Codex inject SessionStart stdout into the session.
 * Grok 1.0.44 ignores it, and also discards an allowing UserPromptSubmit's stdout.
 * Rechecked 2026-09-29 against the installed Grok guide and the Codex 0.155 hook schema.
 */

interface HookInput {
    /** Claude and Codex. */
    session_id?: string;
    /**
     * Grok's documented id. 1.0.44 also sends `session_id`: the account hook wrote pins
     * while it read only that alias. Either field is enough.
     */
    sessionId?: string;
    cwd?: string;
    transcript_path?: string;
    transcriptPath?: string;
    /** Grok's own event name. Absent on the Claude and Codex payloads. */
    hookEventName?: string;
    /** Claude's event name (`SessionStart`, `UserPromptSubmit`, `SessionEnd`). */
    hook_event_name?: string;
    /** Why a Claude session ended, on SessionEnd: `prompt_input_exit` (/exit, Ctrl-D), `logout`, `clear`, `other`. */
    reason?: string;
}

// Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
const HOME = process.env.GENESIS_TOOLS_HOME || homedir();
const REFS_PATH = join(HOME, ".genesis-tools", "claude-code", "cmux-refs.jsonl");
/** surface UUID → the resume binding this hook last gave cmux for that tab. */
const BINDINGS_PATH = join(HOME, ".genesis-tools", "claude-code", "cmux-bindings.json");
/** A binding is set again after this long, in case cmux replaced it with a record of its own since. */
const BINDING_REFRESH_MS = 30 * 60_000;
/** Where each session last wrote its journal line: a prompt in the same tab within the heartbeat writes nothing. */
const LAST_WRITE_PATH = join(HOME, ".genesis-tools", "claude-code", "cmux-refs-last.json");
/**
 * A prompt rewrites an unchanged line at most this often. The journal grew by a line per prompt per agent (19,203 lines,
 * 6.8 MB in seven days on 2026-10-14) and every reader parses all of it; every prompt also paid a `cmux identify`. The
 * live tree knows where a tab is now (the surface UUID survives a move), so a moved tab only waits for the next line.
 */
const HEARTBEAT_MS = 30 * 60_000;
/** SessionEnd reasons that mean the user ended the session on purpose, so it must not come back. */
const DELIBERATE_END = new Set(["prompt_input_exit", "logout"]);

/**
 * Where cmux says this process sits NOW. The UUIDs are the identity: cmux renumbers every `*_ref` at a
 * relaunch, and `CMUX_WORKSPACE_ID` in the agent's env goes stale once the tab moves to another workspace,
 * while identify answers with the current workspace, pane and window.
 */
interface IdentifyCaller {
    surface_id?: string;
    workspace_id?: string;
    pane_id?: string;
    window_id?: string;
    pane_ref?: string;
    surface_ref?: string;
    window_ref?: string;
    workspace_ref?: string;
}

function identifyRefs(): IdentifyCaller {
    const result = spawnSync("cmux", ["--json", "--id-format", "both", "identify"], {
        encoding: "utf8",
        timeout: 1500,
    });

    if (result.status !== 0 || !result.stdout) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(result.stdout) as { caller?: IdentifyCaller };
        return parsed.caller ?? {};
    } catch {
        return {};
    }
}

/**
 * True when the agent this hook runs under is the interactive occupant of its tab.
 *
 * A headless agent inherits the tab's CMUX_SURFACE_ID from whoever started it, so recording it RELABELS
 * the tab with the child's session id: the newest journal line wins, and `cmux tree`, monitor presence
 * and the restore then name the wrong session (2026-09-01: two `claude -p` children stole surface:108
 * from session 7af3dcba; 2026-10-14: a babysit grok worker and a Codex app-server wrote records onto the
 * Claude tab that started them). Env comparison cannot catch it: a nested agent overwrites the session
 * variables for its own children.
 *
 * - Claude names its process in CLAUDE_PID. Use it only for a Claude payload: a Codex or Grok worker started
 *   from a Claude session inherits the PARENT's CLAUDE_PID, which is how those worker records got through.
 * - Otherwise the nearest claude/codex/grok ancestor of this hook is the agent (`findAgentProcess`).
 * - The occupant has a controlling terminal and runs its terminal UI: no `-p`, no `codex exec`, no app-server.
 * - Nothing to read (no such process, no agent ancestor, another harness's agent above a test run): fail open
 *   and record, because losing the journal is worse than one stray line.
 */
export function ownsTab(harness: Harness, claudePid = process.env.CLAUDE_PID, startPid = process.ppid): boolean {
    if (harness === "claude" && claudePid && /^\d+$/.test(claudePid)) {
        const basics = readProcessBasics(Number(claudePid));

        if (basics === null) {
            return true;
        }

        return basics.tty !== null && !(basics.command && isHeadlessAgent({ harness, command: basics.command }));
    }

    const agent = findAgentProcess(startPid);

    if (!agent || agent.harness !== harness) {
        return true;
    }

    return agent.tty !== null && !isHeadlessAgent(agent);
}

interface BindingState {
    sessionId: string;
    command: string;
    at: number;
}

function readBindings(): Record<string, BindingState> {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(BINDINGS_PATH, "utf8"));
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, BindingState>) : {};
    } catch {
        return {};
    }
}

function writeBindings(state: Record<string, BindingState>): void {
    mkdirSync(join(HOME, ".genesis-tools", "claude-code"), { recursive: true });
    const temporary = `${BINDINGS_PATH}.${process.pid}.tmp`;
    writeFileSync(temporary, SafeJSON.stringify(state), "utf8");
    renameSync(temporary, BINDINGS_PATH);
}

interface LastWrite {
    place: string;
    at: number;
}

function readLastWrites(): Record<string, LastWrite> {
    try {
        return existsSync(LAST_WRITE_PATH)
            ? (SafeJSON.parse(readFileSync(LAST_WRITE_PATH, "utf8")) as Record<string, LastWrite>)
            : {};
    } catch {
        return {};
    }
}

/**
 * True when this session wrote a line for the same tab (surface and tmux pane) within the heartbeat, so a prompt
 * has nothing new to say. A session start or a deliberate end always writes.
 */
export function recordedRecently(input: { sessionId: string; place: string; now?: number }): boolean {
    const last = readLastWrites()[input.sessionId];
    return last !== undefined && last.place === input.place && (input.now ?? Date.now()) - last.at < HEARTBEAT_MS;
}

function rememberWrite(input: { sessionId: string; place: string; now: number }): void {
    const state = readLastWrites();
    const kept = Object.fromEntries(Object.entries(state).filter(([, last]) => input.now - last.at < 24 * 60 * 60_000));
    kept[input.sessionId] = { place: input.place, at: input.now };
    const tmp = `${LAST_WRITE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept));
    renameSync(tmp, LAST_WRITE_PATH);
}

function runCmux(args: string[]): boolean {
    return spawnSync("cmux", args, { encoding: "utf8", timeout: 1500 }).status === 0;
}

/**
 * Give cmux the command that resumes this session in this tab (`cmux surface resume set`). cmux keeps the
 * binding with the tab's own state, so it follows the tab across a move and a relaunch, and it replaces the
 * restore record cmux derived from processes it saw in the tab, which can name a stale session (2026-10-14:
 * a day-old grok worker's session, typed into the tab where Claude 1b4001ba ran). The command carries the
 * account from `TOOLS_<AGENT>_ACCOUNT`, never a model. Set only when it changed or is half an hour old, so a
 * prompt costs no cmux call. Runs only where `cmux identify` answered for this tab.
 */
export function syncResumeBinding(input: {
    surfaceId: string;
    harness: Harness;
    sessionId: string;
    cwd: string;
    account?: string;
    now?: number;
    run?: (args: string[]) => boolean;
}): boolean {
    const now = input.now ?? Date.now();
    const argv = resumeArgv(input.harness, input.sessionId, input.account);
    const command = argv.join(" ");
    const state = readBindings();
    const known = state[input.surfaceId];

    if (
        known &&
        known.sessionId === input.sessionId &&
        known.command === command &&
        now - known.at < BINDING_REFRESH_MS
    ) {
        return false;
    }

    const set = (input.run ?? runCmux)([
        "surface",
        "resume",
        "set",
        "--surface",
        input.surfaceId,
        "--kind",
        "agent",
        "--checkpoint",
        input.sessionId,
        "--source",
        "genesis-tools",
        "--name",
        `${input.harness} ${input.sessionId.slice(0, 8)}`,
        "--cwd",
        input.cwd,
        "--",
        ...argv,
    ]);

    if (!set) {
        return false;
    }

    writeBindings({ ...state, [input.surfaceId]: { sessionId: input.sessionId, command, at: now } });
    return true;
}

/** The session ended on purpose: cmux forgets this tab's binding, if it still names this session. */
export function clearResumeBinding(input: {
    surfaceId: string;
    sessionId: string;
    run?: (args: string[]) => boolean;
}): boolean {
    const state = readBindings();

    if (state[input.surfaceId]?.sessionId !== input.sessionId) {
        return false;
    }

    if (!(input.run ?? runCmux)(["surface", "resume", "clear", "--surface", input.surfaceId])) {
        return false;
    }

    const { [input.surfaceId]: _cleared, ...rest } = state;
    writeBindings(rest);
    return true;
}

function main(raw: string): void {
    if (!raw.trim()) {
        return;
    }

    let input: HookInput;

    try {
        input = SafeJSON.parse(raw) as HookInput;
    } catch {
        return;
    }

    const sessionId = (input.session_id ?? input.sessionId)?.trim();

    if (!sessionId) {
        return;
    }

    const workspaceId = process.env.CMUX_WORKSPACE_ID || null;
    const surfaceId = process.env.CMUX_SURFACE_ID || null;
    const tmuxPane = process.env.TMUX_PANE || null;

    // Not in cmux and not in tmux: nothing to record.
    if (!surfaceId && !tmuxPane) {
        return;
    }

    const harness: Harness = harnessFor(input);

    // A headless agent (`-p` child, worker, app-server): the surface in its env is the tab of whoever
    // started it, and recording it would steal that tab's label.
    if (!ownsTab(harness)) {
        return;
    }

    const event = input.hook_event_name ?? input.hookEventName;
    const ending = event === "SessionEnd";
    const place = `${surfaceId ?? ""}\n${tmuxPane ?? ""}`;

    if (event === "UserPromptSubmit" && recordedRecently({ sessionId, place })) {
        return;
    }

    // Only a deliberate end is recorded: after a crash or a cmux quit the session should come back.
    if (ending && !DELIBERATE_END.has(input.reason ?? "")) {
        return;
    }

    const caller = surfaceId && !ending ? identifyRefs() : {};
    const entry = {
        sessionId,
        // Absent means claude, so every record written before this field keeps its meaning.
        ...(harness === "claude" ? {} : { provider: harness }),
        // identify knows the tab's CURRENT workspace; the env value is from when the agent started.
        workspaceId: caller.workspace_id ?? workspaceId,
        surfaceId: caller.surface_id ?? surfaceId,
        paneId: caller.pane_id ?? null,
        windowId: caller.window_id ?? null,
        workspaceRef: caller.workspace_ref ?? null,
        paneRef: caller.pane_ref ?? null,
        surfaceRef: caller.surface_ref ?? null,
        windowRef: caller.window_ref ?? null,
        tmuxPane,
        cwd: input.cwd || process.cwd(),
        at: Date.now(),
        // The user ended this session (`/exit`): readers must not resume it in this tab.
        ...(ending ? { ended: true } : {}),
    };

    const dir = join(HOME, ".genesis-tools", "claude-code");

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Append-only: an O_APPEND write of one short line is atomic, so concurrent
    // sessions never corrupt the journal. Later lines win on read.
    appendFileSync(REFS_PATH, `${SafeJSON.stringify(entry)}\n`, "utf8");
    rememberWrite({ sessionId, place, now: entry.at });

    if (!surfaceId) {
        return;
    }

    if (ending) {
        clearResumeBinding({ surfaceId, sessionId });
        return;
    }

    // identify answered: this process talks to the cmux that shows the tab.
    if (caller.surface_id) {
        syncResumeBinding({
            surfaceId: caller.surface_id,
            harness,
            sessionId,
            cwd: entry.cwd,
            account: process.env[accountEnvVarFor(harness)] || undefined,
        });
    }
}

if (import.meta.main) {
    try {
        main(await Bun.stdin.text());
    } catch {
        // A bookkeeping record is never worth failing a session event over.
    }
}
