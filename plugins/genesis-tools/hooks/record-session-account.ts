#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @genesiscz/utils/json
const SafeJSON = JSON;

/**
 * SessionStart hook: record which account this Claude Code session runs as.
 *
 * Nothing in Claude Code's own transcripts says which account paid for a session, but
 * `tools claude start` exports TOOLS_CLAUDE_ACCOUNT into the launch env — and a hook is a
 * child of claude, so it can see it. `tools claude cmux` reads the journal this writes to
 * resume each session under the account it had before.
 *
 * Silent and never fatal: it runs on every session start, resume, clear and compact.
 * Anything printed on stdout here would be injected into the session as context.
 */

interface HookInput {
    session_id?: string;
    cwd?: string;
    source?: string;
}

interface SessionPin {
    sessionId: string;
    account: string | null;
    /**
     * How the session authenticated. `tools claude start` exports the OAuth token for a
     * token launch and exports nothing for `--keychain`, while BOTH set the account name.
     * Restoring a keychain session through the token path would bill another credential,
     * so the mode has to be recorded, not inferred from the account.
     */
    auth: "token" | "keychain";
    model: string | null;
    cwd: string;
    workspaceId: string | null;
    source: "hook";
    at: number;
}

// Standalone hook script: no access to @genesiscz/utils/env, so process.env directly.
const HOME = process.env.GENESIS_TOOLS_HOME || homedir();
const PINS_PATH = join(HOME, ".genesis-tools", "claude-code", "session-pins.jsonl");
const MAX_PS_HOPS = 6;

/** `--model <id>` / `--model=<id>` out of a command line, if it carries one. */
function modelFromCommand(command: string): string | null {
    const words = command.split(/\s+/);

    for (let i = 0; i < words.length; i++) {
        if ((words[i] === "--model" || words[i] === "-m") && words[i + 1]) {
            return words[i + 1];
        }

        if (words[i].startsWith("--model=")) {
            return words[i].slice("--model=".length);
        }
    }

    return null;
}

/**
 * The model the nearest `claude` ancestor was launched with. A hook is a grandchild of
 * claude (claude → sh → this), so the launch flags are only reachable by walking up the
 * parent chain. Costs one `ps` per hop and gives up quietly.
 */
function modelFromAncestors(): string | null {
    let pid = process.ppid;

    for (let hop = 0; hop < MAX_PS_HOPS && pid > 1; hop++) {
        const result = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });

        if (result.status !== 0 || !result.stdout) {
            return null;
        }

        const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout.trim());

        if (!match) {
            return null;
        }

        if (/(^|\/|\s)claude(\s|$)/.test(match[2])) {
            return modelFromCommand(match[2]);
        }

        pid = Number(match[1]);
    }

    return null;
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

    const pin: SessionPin = {
        sessionId: input.session_id,
        // Absent means a plain keychain login, which is a real answer, not a missing one.
        account: process.env.TOOLS_CLAUDE_ACCOUNT || null,
        auth: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "token" : "keychain",
        model: modelFromAncestors(),
        cwd: input.cwd || process.cwd(),
        workspaceId: process.env.CMUX_WORKSPACE_ID || null,
        source: "hook",
        at: Date.now(),
    };

    const dir = join(HOME, ".genesis-tools", "claude-code");

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    // Append-only: concurrent launches must never interleave into a corrupt document,
    // and an O_APPEND write of one short line is atomic. Later lines win on read.
    appendFileSync(PINS_PATH, `${SafeJSON.stringify(pin)}\n`, "utf8");
}

try {
    main(await Bun.stdin.text());
} catch {
    // A bookkeeping record is never worth failing a session start over.
}
