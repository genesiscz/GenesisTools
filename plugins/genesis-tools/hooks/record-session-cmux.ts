#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @genesiscz/utils/json
const SafeJSON = JSON;

/**
 * SessionStart + UserPromptSubmit hook: journal which cmux pane this Claude
 * Code session lives in, so `tools claude cmux focus/send <session-id>` can
 * resolve a fresh, untitled session instantly instead of guessing from tab
 * titles and pane text.
 *
 * The launch env carries the stable surface/workspace UUIDs; `cmux identify`
 * adds the pane/window refs a focus needs. Re-recorded on every prompt so a
 * session that moves panes (or a cmux restart) heals on the next message.
 *
 * Silent and never fatal, like the other hooks here: stdout would be injected
 * into the session as context.
 */

interface HookInput {
    session_id?: string;
    cwd?: string;
}

// Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
const HOME = process.env.GENESIS_TOOLS_HOME || homedir();
const REFS_PATH = join(HOME, ".genesis-tools", "claude-code", "cmux-refs.jsonl");

interface IdentifyCaller {
    pane_ref?: string;
    surface_ref?: string;
    window_ref?: string;
    workspace_ref?: string;
}

function identifyRefs(): IdentifyCaller {
    const result = spawnSync("cmux", ["--json", "identify"], { encoding: "utf8", timeout: 1500 });

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
 * True when the Claude process this hook belongs to has a controlling tty.
 *
 * A headless child (`claude -p` run from another session's Bash tool, a probe
 * battery, a subagent script) inherits the parent's CMUX_SURFACE_ID, so
 * recording it RELABELS the parent's tab with the child's session id — the
 * newest journal line wins, and `cmux tree`/monitor presence then report the
 * long-lived session in that pane as "not in cmux" (observed 2026-09-01:
 * two `claude -p` children stole surface:108 from session 7af3dcba).
 *
 * Env comparison cannot catch this: a nested claude overwrites
 * CLAUDE_CODE_SESSION_ID for its own children. The tty can — the interactive
 * claude that actually OWNS the pane has one (`ttys…`), a headless run shows
 * `??`. CLAUDE_PID names the claude process in hook env; without it, fail
 * open and record, matching the old behavior.
 */
function claudeHasTty(): boolean {
    const pid = process.env.CLAUDE_PID;

    if (!pid || !/^\d+$/.test(pid)) {
        return true;
    }

    const result = spawnSync("ps", ["-o", "tty=", "-p", pid], { encoding: "utf8", timeout: 1500 });

    if (result.status !== 0 || !result.stdout) {
        return true;
    }

    // macOS prints `??` for "no controlling tty", Linux prints `?`.
    const tty = result.stdout.trim();
    return tty !== "??" && tty !== "?";
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

    if (!input.session_id) {
        return;
    }

    const workspaceId = process.env.CMUX_WORKSPACE_ID || null;
    const surfaceId = process.env.CMUX_SURFACE_ID || null;
    const tmuxPane = process.env.TMUX_PANE || null;

    // Not in cmux and not in tmux: nothing to record.
    if (!surfaceId && !tmuxPane) {
        return;
    }

    // Headless claude (`-p` child, probe, subagent): the surface in its env is
    // its PARENT's pane, and recording it would steal that pane's label.
    if (!claudeHasTty()) {
        return;
    }

    const caller = surfaceId ? identifyRefs() : {};
    const entry = {
        sessionId: input.session_id,
        workspaceId,
        surfaceId,
        workspaceRef: caller.workspace_ref ?? null,
        paneRef: caller.pane_ref ?? null,
        surfaceRef: caller.surface_ref ?? null,
        windowRef: caller.window_ref ?? null,
        tmuxPane,
        cwd: input.cwd || process.cwd(),
        at: Date.now(),
    };

    const dir = join(HOME, ".genesis-tools", "claude-code");

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Append-only: an O_APPEND write of one short line is atomic, so concurrent
    // sessions never corrupt the journal. Later lines win on read.
    appendFileSync(REFS_PATH, `${SafeJSON.stringify(entry)}\n`, "utf8");
}

try {
    main(await Bun.stdin.text());
} catch {
    // A bookkeeping record is never worth failing a session event over.
}
