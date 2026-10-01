#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { accountEnvVarFor, type Harness, harnessFor } from "./harness";

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
 * Claude and Codex inject SessionStart stdout into the session. Grok 1.0.44 ignores it
 * (that sentence is in the 1.0.44 binary). Printing would still land in the other two.
 */

interface HookInput {
    session_id?: string;
    /** Grok's name for the same id. */
    sessionId?: string;
    cwd?: string;
    source?: string;
    transcript_path?: string;
    /** Grok's name for the same path. */
    transcriptPath?: string;
    /** Codex 0.155 requires this on SessionStart. Absent on the Grok 1.0.44 common fields. */
    model?: string;
    /** Grok sends the event name; with no transcript path it is what marks the payload as Grok. */
    hookEventName?: string;
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
 * Never fall back to another harness's variable: that is precisely how a Codex session started
 * inside a Claude pane came to carry a Claude account. When the variable is absent the home in
 * the transcript still names an account, via {@link accountBoundToHome}. That is the config
 * binding, not a guess from a sibling's env.
 */
export function accountFor(harness: Harness, env: NodeJS.ProcessEnv): string | null {
    return env[accountEnvVarFor(harness)] || null;
}

interface ConfigAccount {
    name?: unknown;
    provider?: unknown;
    accountUuid?: unknown;
    credentials?: { authFile?: unknown; dataDir?: unknown };
}

/** `~/.codex`, `~/.codex-shop`, `~/.grok`, `~/.grok-side` — the directory the transcript lives under. */
function agentHome(transcript: string): string | null {
    const match = /^(.*\/\.(?:codex|grok)[^/]*)\//.exec(transcript);

    return match?.[1] ?? null;
}

function expandHome(path: string): string {
    if (path === "~") {
        return homedir();
    }

    if (path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }

    return path;
}

function configAccounts(): ConfigAccount[] {
    const path = join(HOME, ".genesis-tools", "ai", "config.json");

    if (!existsSync(path)) {
        return [];
    }

    try {
        const doc = SafeJSON.parse(readFileSync(path, "utf8")) as { accounts?: unknown };

        return Array.isArray(doc.accounts) ? (doc.accounts as ConfigAccount[]) : [];
    } catch (err) {
        console.warn("[record-session-account] ai config was not readable", err);

        return [];
    }
}

/**
 * The account whose saved auth file or data dir is this home.
 *
 * One match is a name. Zero or several is null: two accounts pointing at one home is not
 * something this hook should pick between. Grok is matched on `auth.json` exactly, the same
 * way home discovery does. Codex also accepts an auth file inside the home or a `dataDir`.
 */
function accountBoundToHome(home: string, provider: string): string | null {
    const resolvedHome = resolve(home);
    const prefix = `${resolvedHome}${sep}`;
    const authJson = resolve(home, "auth.json");
    const names: string[] = [];

    for (const account of configAccounts()) {
        if (account.provider !== provider || typeof account.name !== "string" || account.name.length === 0) {
            continue;
        }

        const rawAuth = account.credentials?.authFile;
        const rawDir = account.credentials?.dataDir;
        const authFile = typeof rawAuth === "string" && rawAuth.length > 0 ? resolve(expandHome(rawAuth)) : undefined;
        const dataDir = typeof rawDir === "string" && rawDir.length > 0 ? resolve(expandHome(rawDir)) : undefined;
        const matches =
            provider === "grok-sub"
                ? authFile === authJson
                : authFile === authJson || authFile?.startsWith(prefix) || dataDir === resolvedHome;

        if (matches) {
            names.push(account.name);
        }
    }

    if (names.length > 1) {
        return null;
    }

    if (names.length === 1) {
        return names[0];
    }

    return accountByAuthIdentity(home, provider);
}

function readAuthJson(path: string): unknown {
    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        console.warn("[record-session-account] auth file was not readable", err);

        return null;
    }
}

/** Official Codex CLI stores `tokens.account_id`; some writers use a top-level `accountId`. */
function codexAccountId(raw: unknown): string | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }

    const doc = raw as { tokens?: { account_id?: unknown }; accountId?: unknown };

    if (typeof doc.tokens?.account_id === "string" && doc.tokens.account_id.length > 0) {
        return doc.tokens.account_id;
    }

    if (typeof doc.accountId === "string" && doc.accountId.length > 0) {
        return doc.accountId;
    }

    return null;
}

function jwtSub(token: string): string | null {
    const part = token.split(".")[1];

    if (!part) {
        return null;
    }

    try {
        const payload = SafeJSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { sub?: unknown };

        return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
    } catch (err) {
        console.warn("[record-session-account] auth jwt subject was not readable", err);

        return null;
    }
}

/** Grok's auth file is a map of entries. Discovery stores the JWT `sub` as `accountUuid`. */
function grokAccountIds(raw: unknown): string[] {
    if (typeof raw !== "object" || raw === null) {
        return [];
    }

    const ids: string[] = [];

    for (const value of Object.values(raw)) {
        if (typeof value !== "object" || value === null) {
            continue;
        }

        const entry = value as { key?: unknown; user_id?: unknown };

        if (typeof entry.user_id === "string" && entry.user_id.length > 0) {
            ids.push(entry.user_id);
        }

        if (typeof entry.key === "string") {
            const sub = jwtSub(entry.key);

            if (sub) {
                ids.push(sub);
            }
        }
    }

    return ids;
}

/**
 * When the config has no path for this home, the id inside auth.json still matches
 * `accountUuid`. Several matches stay null. The token itself is never recorded.
 */
function accountByAuthIdentity(home: string, provider: string): string | null {
    const raw = readAuthJson(join(home, "auth.json"));
    const ids = new Set(provider === "grok-sub" ? grokAccountIds(raw) : [codexAccountId(raw)].filter((id) => id));
    const names = configAccounts()
        .filter(
            (account) =>
                account.provider === provider &&
                typeof account.accountUuid === "string" &&
                ids.has(account.accountUuid) &&
                typeof account.name === "string"
        )
        .map((account) => account.name as string);

    return names.length === 1 ? names[0] : null;
}

function providerId(harness: Harness): string | null {
    if (harness === "codex") {
        return "openai-sub";
    }

    if (harness === "grok") {
        return "grok-sub";
    }

    return null;
}

/** The pin file is read in chunks this size, the newest first, so memory stays bounded however long it grows. */
const PIN_CHUNK_BYTES = 1024 * 1024;

/** The account a pin line names when it is this session's, on this provider; else null. */
function pinAccount(line: string, sessionId: string, harness: string): string | null {
    if (!line.includes(sessionId)) {
        return null;
    }

    try {
        const pin = SafeJSON.parse(line) as Partial<SessionPin>;
        return pin.sessionId === sessionId && pin.provider === harness && typeof pin.account === "string" && pin.account
            ? pin.account
            : null;
    } catch {
        // A corrupt line: skipped.
        return null;
    }
}

/**
 * The account an earlier pin of this session (same provider) recorded, the newest one winning. Reads the
 * journal backwards chunk by chunk and stops at the first (newest) match, so an old session pinned far
 * from the tail is still found, with memory bounded by one chunk plus one line.
 */
export function priorAccount(
    path: string,
    sessionId: string,
    harness: string,
    chunkBytes: number = PIN_CHUNK_BYTES
): string | null {
    let fd: number;
    let size: number;

    try {
        size = statSync(path).size;
        fd = openSync(path, "r");
    } catch {
        // No pin file yet is the normal case for a first session.
        return null;
    }

    try {
        let end = size;
        // The start of the line that straddled the previous chunk's head, carried to the next (earlier) one.
        let carry = Buffer.alloc(0);

        while (end > 0) {
            const from = Math.max(0, end - chunkBytes);
            const chunk = Buffer.alloc(end - from);
            readSync(fd, chunk, 0, chunk.length, from);
            const bytes = Buffer.concat([chunk, carry]);
            // Unless this chunk starts the file, its first line may begin in the earlier chunk: those bytes
            // are carried raw, so a UTF-8 character split at the chunk boundary is never decoded in halves.
            const newline = from > 0 ? bytes.indexOf(0x0a) : -1;
            carry = from > 0 ? bytes.subarray(0, newline < 0 ? bytes.length : newline) : Buffer.alloc(0);
            const complete = from > 0 ? (newline < 0 ? Buffer.alloc(0) : bytes.subarray(newline + 1)) : bytes;
            const lines = complete.toString("utf8").split("\n");

            for (let i = lines.length - 1; i >= 0; i--) {
                const account = pinAccount(lines[i] ?? "", sessionId, harness);

                if (account) {
                    return account;
                }
            }

            end = from;
        }

        return carry.length > 0 ? pinAccount(carry.toString("utf8"), sessionId, harness) : null;
    } finally {
        closeSync(fd);
    }
}

function main(raw: string): void {
    if (!raw.trim()) {
        return;
    }

    let input: HookInput;

    try {
        input = SafeJSON.parse(raw) as HookInput;
    } catch (err) {
        console.warn("[record-session-account] payload was not json", err);

        return;
    }

    const sessionId = (input.session_id ?? input.sessionId)?.trim();
    const transcript = input.transcript_path ?? input.transcriptPath ?? "";

    if (!sessionId) {
        return;
    }

    const harness = harnessFor(input);
    const fromEnv = accountFor(harness, process.env);
    const home = agentHome(transcript);
    const provider = providerId(harness);
    const fromPayload = typeof input.model === "string" ? input.model.trim() : "";
    const pin: SessionPin = {
        sessionId,
        ...(harness === "claude" ? {} : { provider: harness }),
        // Env wins: `tools <agent> run` said which account this process is. The home binding
        // covers a terminal the user opened themselves. Claude has no home binding.
        // A session that already has a pin (resume, clear, compact) keeps it: today's home binding says
        // who is logged in now, not who owned the session. Only a new session is pinned from the home.
        account:
            fromEnv ||
            (harness === "claude" ? null : priorAccount(PINS_PATH, sessionId, harness)) ||
            (home && provider ? accountBoundToHome(home, provider) : null),
        // Claude-only, and deliberately not faked for the others: the ancestor walk looks for a
        // `claude` process and the auth modes are Claude's.
        ...(harness === "claude" ? resolveAuth(process.env) : {}),
        // The payload wins when the harness sends it (Codex 0.155 SessionStart requires `model`).
        // Claude often omits it; the launch flag on the claude ancestor is the fallback.
        model: fromPayload || (harness === "claude" ? modelFromAncestors() : null),
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
