import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLimits } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/limits";
import { snapshotToAccountUsage } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage";
import { StatuslineCache } from "@genesiscz/utils/ai/statusline/cache";
import type { AccountSegmentData, StatuslineFeature, StatuslinePayload } from "@genesiscz/utils/ai/statusline/types";
import type { Cached } from "@genesiscz/utils/ai/usage-poll/shared-cache";
import { snapshotsCacheKey, USAGE_CACHE_TTL, usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * Claude Code's statusline, as the host feature the generic renderer drives.
 *
 * Every lookup here replaces a process the shell script spawned per render: the transcript tail
 * is one sliced read instead of two `tail | jq` pipelines, the session title comes from the index
 * file only when its mtime moved, the account comes from the environment or a cached answer and
 * only once per session from a `ps` walk, and usage is the poller's cache file read in-process
 * instead of a `tools claude info` bun launch.
 */

/**
 * How much of the transcript to read from the end, growing until both facts are found. The shell
 * script tailed 100 LINES, and a tool result can be hundreds of KB on one line, so a fixed byte
 * window missed the last message on a real transcript (the benchmark sample lost its `@HH:MM:SS`).
 */
const TRANSCRIPT_TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
/** How long an "no account found" answer is trusted before the `ps` walk runs again. */
const ACCOUNT_MISS_TTL_MS = 60_000;
const PROVIDER = "anthropic-sub";

interface TranscriptFacts {
    modelId: string | null;
    lastMessageIso: string | null;
}

const transcriptFacts = new WeakMap<StatuslinePayload, Promise<TranscriptFacts>>();

function claudeDir(): string {
    return env.paths.getClaudeConfigDir() ?? join(homedir(), ".claude");
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

export function parseClaudeCodePayload(raw: Record<string, unknown>): StatuslinePayload | null {
    const workspace = asRecord(raw.workspace);
    const cwd = asString(workspace?.current_dir) ?? asString(raw.cwd);

    if (!cwd) {
        return null;
    }

    const model = asRecord(raw.model);
    const contextWindow = asRecord(raw.context_window);
    const usage = asRecord(contextWindow?.current_usage);
    const agent = asRecord(raw.agent);

    return {
        host: "claude-code",
        cwd,
        projectDir: asString(workspace?.project_dir),
        sessionId: asString(raw.session_id),
        transcriptPath: asString(raw.transcript_path),
        modelDisplayName: asString(model?.display_name),
        modelId: asString(model?.id),
        contextWindowSize: asNumber(contextWindow?.context_window_size),
        usage: usage
            ? {
                  inputTokens: asNumber(usage.input_tokens) ?? 0,
                  cacheCreationTokens: asNumber(usage.cache_creation_input_tokens) ?? 0,
                  cacheReadTokens: asNumber(usage.cache_read_input_tokens) ?? 0,
              }
            : null,
        isAgentFrame: asString(agent?.name) !== null,
        raw,
    };
}

/**
 * The last real assistant model and the last main-thread message time, from one tail read.
 * `<synthetic>` records are Claude Code's own notices, not turns; sidechain lines are subagents.
 */
async function readTranscriptFacts(payload: StatuslinePayload): Promise<TranscriptFacts> {
    const path = payload.transcriptPath;

    if (!path || !existsSync(path)) {
        return { modelId: null, lastMessageIso: null };
    }

    let modelId: string | null = null;
    let lastMessageIso: string | null = null;
    let size = 0;

    try {
        size = statSync(path).size;
    } catch (error) {
        logger.debug({ err: error, path }, "statusline: transcript stat failed");

        return { modelId, lastMessageIso };
    }

    for (const bytes of TRANSCRIPT_TAIL_STEPS) {
        const facts = await scanTail(path, bytes);
        modelId = facts.modelId ?? modelId;
        lastMessageIso = facts.lastMessageIso ?? lastMessageIso;

        if ((modelId && lastMessageIso) || bytes >= size) {
            break;
        }
    }

    return { modelId, lastMessageIso };
}

async function scanTail(path: string, bytes: number): Promise<TranscriptFacts> {
    let modelId: string | null = null;
    let lastMessageIso: string | null = null;

    try {
        const lines = await readTailBytes(path, bytes);

        for (const line of lines) {
            let record: Record<string, unknown> | null;

            try {
                record = asRecord(SafeJSON.parse(line, { strict: true }));
            } catch (error) {
                logger.debug({ err: error, path }, "statusline: skipping a transcript line that is not JSON");
                continue;
            }

            if (!record) {
                continue;
            }

            const type = asString(record.type);

            if (type === "assistant") {
                const message = asRecord(record.message);
                const model = asString(message?.model);

                if (model && model !== "<synthetic>") {
                    modelId = model;
                }
            }

            if ((type === "user" || type === "assistant") && record.isSidechain !== true) {
                lastMessageIso = asString(record.timestamp) ?? lastMessageIso;
            }
        }
    } catch (error) {
        logger.debug({ err: error, path }, "statusline: transcript tail read failed");
    }

    return { modelId, lastMessageIso };
}

function factsFor(payload: StatuslinePayload): Promise<TranscriptFacts> {
    let facts = transcriptFacts.get(payload);

    if (!facts) {
        facts = readTranscriptFacts(payload);
        transcriptFacts.set(payload, facts);
    }

    return facts;
}

function localHms(iso: string): string | null {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const pad = (n: number) => String(n).padStart(2, "0");

    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `/foo/bar` becomes `-foo-bar`, the form Claude Code names its per-project directories with. */
function escapedProjectDir(projectDir: string): string {
    return projectDir.replace(/\//g, "-");
}

async function resolveSessionName(payload: StatuslinePayload, cache: StatuslineCache): Promise<string | null> {
    if (!payload.sessionId || !payload.projectDir) {
        return null;
    }

    const indexPath = join(claudeDir(), "projects", escapedProjectDir(payload.projectDir), "sessions-index.json");

    if (!existsSync(indexPath)) {
        return null;
    }

    const mtime = statSync(indexPath).mtimeMs;
    const entry = cache.session(payload.sessionId);

    if (entry.sessionName !== undefined && entry.sessionNameIndexMtime === mtime) {
        return entry.sessionName;
    }

    let name: string | null = null;

    try {
        const index = asRecord(SafeJSON.parse(readFileSync(indexPath, "utf8"), { strict: true }));
        const entries = Array.isArray(index?.entries) ? index.entries : [];

        for (const candidate of entries) {
            const record = asRecord(candidate);

            if (record && record.sessionId === payload.sessionId) {
                name = asString(record.customTitle);
                break;
            }
        }
    } catch (error) {
        logger.debug({ err: error, indexPath }, "statusline: sessions index unreadable");
    }

    cache.writeSession(payload.sessionId, { sessionName: name, sessionNameIndexMtime: mtime });

    return name;
}

/**
 * The account this session launched as. `tools claude start` exports `TOOLS_CLAUDE_ACCOUNT` into
 * claude's environment, and the statusline is claude's child, so the variable is usually right
 * here. Failing that, the SessionStart hook's pin journal, then claude's own environment through
 * `ps eww`, cached per session because the answer cannot change while the session lives.
 */
function resolveAccountName(payload: StatuslinePayload, cache: StatuslineCache, now: number): string | null {
    const fromEnv = asString(process.env.TOOLS_CLAUDE_ACCOUNT);

    if (fromEnv) {
        return fromEnv;
    }

    const sessionId = payload.sessionId;

    if (!sessionId) {
        return null;
    }

    const entry = cache.session(sessionId);

    if (entry.account !== undefined && entry.accountAt !== undefined) {
        if (entry.account !== "" || now - entry.accountAt < ACCOUNT_MISS_TTL_MS) {
            return entry.account || null;
        }
    }

    const found = accountFromPinJournal(sessionId) ?? accountFromAncestors();
    cache.writeSession(sessionId, { account: found ?? "", accountAt: now });

    return found;
}

function accountFromPinJournal(sessionId: string): string | null {
    const path = join(new Storage("claude-code").getBaseDir(), "session-pins.jsonl");

    if (!existsSync(path)) {
        return null;
    }

    let account: string | null = null;

    try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (!line.includes(sessionId)) {
                continue;
            }

            const pin = asRecord(SafeJSON.parse(line, { strict: true }));

            if (pin && pin.sessionId === sessionId && (pin.provider === undefined || pin.provider === "claude")) {
                account = asString(pin.account);
            }
        }
    } catch (error) {
        logger.debug({ err: error, path }, "statusline: pin journal unreadable");
    }

    return account;
}

/** Walk up to six ancestors reading their environment; one `ps eww` per hop, once per session. */
function accountFromAncestors(): string | null {
    let pid = process.ppid;

    for (let hop = 0; hop < 6 && pid > 1; hop++) {
        const envDump = spawnSync("ps", ["eww", String(pid)], { encoding: "utf8" });
        const match = /(?:^|\s)TOOLS_CLAUDE_ACCOUNT=(\S+)/.exec(envDump.stdout ?? "");

        if (match?.[1]) {
            return match[1];
        }

        const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
        pid = Number.parseInt((parent.stdout ?? "").trim(), 10);

        if (!Number.isFinite(pid)) {
            break;
        }
    }

    return null;
}

/** The poller's cache file, read in-process: the same bytes `tools claude info` printed. */
async function usageFor(accountName: string): Promise<AccountSegmentData> {
    const empty: AccountSegmentData = {
        name: accountName,
        fiveHour: null,
        sevenDay: null,
        sevenDayFable: null,
        stale: false,
        fetchedAt: null,
    };
    const cached = await usagePollStorage().getCacheFile<Cached<AccountUsageSnapshot>>(
        snapshotsCacheKey(PROVIDER),
        USAGE_CACHE_TTL
    );

    if (!cached) {
        return empty;
    }

    const snapshot = cached.accounts.find((entry) => entry.accountName === accountName);

    if (!snapshot) {
        return empty;
    }

    const account = snapshotToAccountUsage(snapshot);
    const buckets: Record<string, number> = {};

    if (account.usage) {
        for (const limit of normalizeLimits(account.usage)) {
            buckets[limit.bucket] = Math.round(limit.percent);
        }
    }

    return {
        name: accountName,
        fiveHour: buckets.five_hour ?? null,
        sevenDay: buckets.seven_day ?? null,
        sevenDayFable: buckets.seven_day_fable ?? null,
        stale: Boolean(account.stale),
        fetchedAt: cached.accountFetchedAt?.[accountName] ?? cached.fetchedAt ?? null,
    };
}

async function resolveAutocompact(cache: StatuslineCache): Promise<boolean | null> {
    const path = join(claudeDir(), ".claude.json");

    if (!existsSync(path)) {
        return null;
    }

    const mtime = statSync(path).mtimeMs;
    const cached = cache.keyed<boolean>("autocompact", mtime);

    if (cached !== null) {
        return cached;
    }

    let enabled = true;

    try {
        const settings = asRecord(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        enabled = settings?.autoCompactEnabled !== false;
    } catch (error) {
        logger.debug({ err: error, path }, "statusline: .claude.json unreadable, assuming autocompact on");
    }

    cache.writeKeyed("autocompact", mtime, enabled);

    return enabled;
}

function settingsPath(): string {
    return join(claudeDir(), "settings.json");
}

/** `~/.claude/settings.json` is a symlink into the GenesisClaude repo; write the real file. */
function settingsRealPath(): string {
    const path = settingsPath();

    return existsSync(path) ? realpathSync(path) : path;
}

async function readInstalledCommand(): Promise<string | null> {
    const path = settingsRealPath();

    if (!existsSync(path)) {
        return null;
    }

    const settings = asRecord(SafeJSON.parse(readFileSync(path, "utf8")));
    const statusLine = asRecord(settings?.statusLine);

    return asString(statusLine?.command);
}

async function writeInstalledCommand(command: string | null): Promise<void> {
    const path = settingsRealPath();
    const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
    const settings = (SafeJSON.parse(text) as Record<string, unknown> | undefined) ?? {};

    if (command === null) {
        delete settings.statusLine;
    } else {
        settings.statusLine = { type: "command", command };
    }

    writeFileSync(path, `${SafeJSON.stringify(settings, null, 2)}\n`);
    logger.info({ path, command }, "statusline: Claude Code settings updated");
}

export function claudeCodeStatusline(cache = new StatuslineCache()): StatuslineFeature {
    return {
        host: "Claude Code",
        parsePayload: parseClaudeCodePayload,
        resolveModel: async (payload) => {
            const facts = await factsFor(payload);

            return facts.modelId;
        },
        resolveLastMessageTime: async (payload) => {
            const facts = await factsFor(payload);

            return facts.lastMessageIso ? localHms(facts.lastMessageIso) : null;
        },
        resolveSessionName: (payload) => resolveSessionName(payload, cache),
        resolveAccount: async (payload) => {
            const name = resolveAccountName(payload, cache, Date.now());

            return name ? usageFor(name) : null;
        },
        resolveAutocompact: () => resolveAutocompact(cache),
        settingsPath,
        readInstalledCommand,
        writeInstalledCommand,
    };
}
