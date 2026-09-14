#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnvVarFor, type Harness, harnessOf } from "./harness";

// biome-ignore lint/style/noRestrictedGlobals: standalone hook script — cannot import @genesiscz/utils/json
const SafeJSON = JSON;

/**
 * SessionStart hook: record which account this session runs as.
 *
 * Nothing in any agent's own transcripts says which account paid for a session, but
 * `tools <agent> run` exports `TOOLS_<AGENT>_ACCOUNT` into the launch env — and a hook is a
 * child of the agent, so it can see it. `tools claude cmux` reads the journal this writes to
 * resume each session under the account it had before, and the Codex and Grok session lists
 * read it to attribute a past session at all.
 *
 * 🛑 The harness comes from the PAYLOAD, never the environment. Codex and Grok run this same
 * plugin hook, and a Codex session started from inside a Claude session inherits
 * `TOOLS_CLAUDE_ACCOUNT`. Reading env-first wrote a Claude account against a Codex thread id
 * 9 times in this journal before `harnessOf` was applied here.
 *
 * Silent and never fatal: it runs on every session start, resume, clear and compact.
 * Anything printed on stdout here would be injected into the session as context.
 */

interface HookInput {
    session_id?: string;
    cwd?: string;
    source?: string;
    transcript_path?: string;
}

interface SessionPin {
    sessionId: string;
    /**
     * Which agent wrote this record. ABSENT means Claude: every line written before this
     * field existed is a Claude session, or a Codex one wrongly holding a Claude account, and
     * a reader for another provider must not treat either as its own.
     */
    provider?: Harness;
    account: string | null;
    /**
     * How the session authenticated. Do NOT infer this from CLAUDE_CODE_OAUTH_TOKEN:
     * Claude Code strips that secret from hook children, so every token launch used
     * to be recorded as keychain. Prefer TOOLS_CLAUDE_AUTH from `tools claude start`.
     */
    auth?: "token" | "keychain";
    authSource?: "launch-env" | "argv" | "oauth-env" | "default-named" | "default-bare";
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
 * The ancestor command lines, nearest first, stopping at the first `claude`.
 * A hook is a grandchild of claude (claude → sh → this), so the launch flags are
 * only reachable by walking up the parent chain. One `ps` per hop, gives up quietly.
 *
 * Walked ONCE and cached: model detection and keychain detection each used to
 * do their own walk, so a SessionStart could spawn `ps` up to 2 * MAX_PS_HOPS
 * times before returning, which the user waits for (PR #341 review round 4, t5).
 */
let ancestorCommandsCache: string[] | null = null;

function ancestorCommands(): string[] {
    if (ancestorCommandsCache !== null) {
        return ancestorCommandsCache;
    }

    const commands: string[] = [];
    let pid = process.ppid;

    for (let hop = 0; hop < MAX_PS_HOPS && pid > 1; hop++) {
        const result = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });

        if (result.status !== 0 || !result.stdout) {
            break;
        }

        const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout.trim());

        if (!match) {
            break;
        }

        commands.push(match[2]);

        if (/(^|\/|\s)claude(\s|$)/.test(match[2])) {
            break;
        }

        pid = Number(match[1]);
    }

    ancestorCommandsCache = commands;
    return commands;
}

/** The model the nearest `claude` ancestor was launched with. */
function modelFromAncestors(): string | null {
    for (const command of ancestorCommands()) {
        if (/(^|\/|\s)claude(\s|$)/.test(command)) {
            return modelFromCommand(command);
        }
    }

    return null;
}

function ancestorHasKeychainFlag(): boolean {
    return ancestorCommands().some((command) => /\s--keychain(\s|$)/.test(command) && /claude/.test(command));
}

/**
 * Claude's token-versus-keychain question, which only Claude has: Codex and Grok authenticate
 * from the vault through their own launchers and have no second mode to distinguish.
 */
function resolveAuth(env: NodeJS.ProcessEnv): Pick<SessionPin, "auth" | "authSource"> {
    const explicit = env.TOOLS_CLAUDE_AUTH;

    if (explicit === "keychain" || explicit === "token") {
        return { auth: explicit, authSource: "launch-env" };
    }

    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
        return { auth: "token", authSource: "oauth-env" };
    }

    if (ancestorHasKeychainFlag()) {
        return { auth: "keychain", authSource: "argv" };
    }

    if (env.TOOLS_CLAUDE_ACCOUNT) {
        return { auth: "token", authSource: "default-named" };
    }

    return { auth: "keychain", authSource: "default-bare" };
}

/**
 * The account this session bills, read ONLY from its own harness's variable.
 *
 * Never fall back to another harness's: that is precisely how a Codex session started inside a
 * Claude pane came to carry a Claude account. An absent variable is a real answer — the agent
 * was launched outside `tools <agent> run` — not a reason to guess.
 */
export function accountFor(harness: Harness, env: NodeJS.ProcessEnv): string | null {
    return env[accountEnvVarFor(harness)] || null;
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

    const harness = harnessOf(input);
    const pin: SessionPin = {
        sessionId: input.session_id,
        ...(harness === "claude" ? {} : { provider: harness }),
        // Absent means the agent was launched outside `tools <agent> run`, which for Claude is
        // a plain keychain login. That is a real answer, not a missing one.
        account: accountFor(harness, process.env),
        // Claude-only, and deliberately not faked for the others: the ancestor walk looks for a
        // `claude` process and the auth modes are Claude's.
        ...(harness === "claude" ? resolveAuth(process.env) : {}),
        model: harness === "claude" ? modelFromAncestors() : null,
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

// Guarded, because this module exports `accountFor` for its test: an unguarded top-level read
// of stdin would hang the moment anything imported it.
if (import.meta.main) {
    try {
        main(await Bun.stdin.text());
    } catch {
        // A bookkeeping record is never worth failing a session start over.
    }
}
