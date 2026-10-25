import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sinceToMs } from "@app/ai-proxy/commands/sessions";
import {
    clientProviderDenial,
    type ResolvedClient,
    resolveClient,
    routeDenial,
    sessionKeyRejection,
} from "@app/ai-proxy/lib/clients";
import {
    _resetSessionKeyIndexForTest,
    type AiProxySessionRecord,
    closeSessionRecord,
    createSessionRecord,
    hashSessionKey,
    newSessionKey,
    noteSessionRequest,
    openSessionRecord,
    readSessionRecord,
    resolveSessionKey,
    sessionsDir,
    sweepSessionRecords,
    updateSessionRecord,
    writeSessionRecord,
} from "@app/ai-proxy/lib/sessions/records";
import { requestTagsFor } from "@app/ai-proxy/lib/sessions/tags";
import { requestRow, requestRows, statsByAgent } from "@app/ai-proxy/lib/sessions/view";
import { resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyAccountConfig, AiProxyConfig } from "@app/ai-proxy/lib/types";
import type { UsageRequestRecord } from "@app/ai-proxy/lib/usage/types";
import { compressBytes } from "@genesiscz/utils/compress/zstd";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const SESSION = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const originalHome = env.get("GENESIS_TOOLS_HOME");

const codex: AiProxyAccountConfig = {
    name: "codex",
    provider: "openai-subscription",
    providerSlug: "codex",
    enabled: true,
};
const claude: AiProxyAccountConfig = {
    name: "personal",
    provider: "anthropic-subscription",
    providerSlug: "claude-sub",
    enabled: true,
};
const metered: AiProxyAccountConfig = { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true };

function config(): AiProxyConfig {
    return { proxyApiKey: "owner-key-0123456789" } as AiProxyConfig;
}

function bearer(token: string): Request {
    return new Request("http://localhost/v1/messages", { headers: { Authorization: `Bearer ${token}` } });
}

function newSession(overrides: Partial<Parameters<typeof createSessionRecord>[0]> = {}) {
    return createSessionRecord({
        id: SESSION,
        codexProxyAccount: "codex",
        claudeProxyAccount: "personal",
        ...overrides,
    });
}

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-proxy-sessions-")));
    resetAiProxyStorage();
    _resetSessionKeyIndexForTest();
});

afterEach(() => {
    resetAiProxyStorage();
    _resetSessionKeyIndexForTest();

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("session records", () => {
    it("writes the record 0600 in a 0700 folder, with the key's hash and never the key", () => {
        const { record, key } = newSession({ cwd: "/work/project" });
        const path = join(sessionsDir(), `${SESSION}.json`);
        const text = readFileSync(path, "utf8");

        expect(key).toMatch(/^gts_[A-Za-z0-9_-]{43}$/);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(sessionsDir()).mode & 0o777).toBe(0o700);
        expect(text).not.toContain(key);
        expect(record.keyHash).toBe(hashSessionKey(key));
        expect(readSessionRecord(SESSION)).toEqual(record);
        expect(() => newSession()).toThrow("already has a record");
    });

    it("resolves a key by hash, rescans once for a record another process wrote, and knows a closed one", () => {
        const { key } = newSession();
        expect(resolveSessionKey(key).state).toBe("open");

        // The launcher writes its record from another process: this process's index has never seen it.
        const otherKey = newSessionKey();
        const other: AiProxySessionRecord = {
            version: 1,
            id: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c",
            keyHash: hashSessionKey(otherKey),
            createdAt: new Date().toISOString(),
            codexProxyAccount: "codex",
            moves: [],
            meteredConfirmed: [],
        };
        writeSessionRecord(other);
        expect(resolveSessionKey(otherKey)).toEqual({ state: "open", record: other });

        expect(resolveSessionKey(newSessionKey()).state).toBe("unknown");
        closeSessionRecord(SESSION);
        expect(resolveSessionKey(key).state).toBe("closed");
    });

    it("reopens the same record on --resume with a fresh key, keeping its history and earlier confirmations", () => {
        const first = openSessionRecord({
            id: SESSION,
            codexAccount: "work",
            meteredConfirmed: [{ account: "billed", confirmedAt: "2026-10-25T20:00:00.000Z", how: "flag" }],
        });
        closeSessionRecord(SESSION);
        const second = openSessionRecord({ id: SESSION, codexAccount: "side", claudeAccount: "personal" });

        expect([first.reopened, second.reopened]).toEqual([false, true]);
        expect(resolveSessionKey(first.key).state).toBe("unknown");
        expect(resolveSessionKey(second.key).state).toBe("open");
        expect(second.record).toMatchObject({
            createdAt: first.record.createdAt,
            codexAccount: "side",
            claudeAccount: "personal",
            meteredConfirmed: [{ account: "billed", how: "flag" }],
        });
        expect(second.record.closedAt).toBeUndefined();
    });
});

describe("session keys at the door", () => {
    it("an open key is a session client; an unknown or closed key gets a reason, never another identity", async () => {
        const { key } = newSession();
        const client = await resolveClient(bearer(key), config());

        expect(client?.name).toBe("session");
        expect(client?.isOwner).toBe(false);
        expect(client?.session?.id).toBe(SESSION);
        expect(sessionKeyRejection(bearer(key))).toBeNull();
        expect(sessionKeyRejection(bearer("owner-key-0123456789"))).toBeNull();

        const unknown = newSessionKey();
        expect(await resolveClient(bearer(unknown), config())).toBeNull();
        expect(sessionKeyRejection(bearer(unknown))).toContain(
            "unknown or closed session; relaunch with tools claude codex"
        );

        closeSessionRecord(SESSION);
        expect(await resolveClient(bearer(key), config())).toBeNull();
        expect(sessionKeyRejection(bearer(key))).toContain(`session ${SESSION} closed`);
    });
});

describe("routeDenial", () => {
    const owner: ResolvedClient = { name: "owner", isOwner: true };
    const alice: ResolvedClient = {
        name: "alice",
        isOwner: false,
        config: { name: "alice", key: "alice-key-0123456789" },
    };

    it("a session routes to the subscription accounts its record names, and to no other", () => {
        const { record } = newSession();
        const client: ResolvedClient = { name: "session", isOwner: false, session: record };

        expect(routeDenial(client, codex)).toBeNull();
        expect(routeDenial(client, claude)).toBeNull();
        expect(routeDenial(client, { ...claude, name: "olivia" })).toContain('account "olivia" is not part of session');
        // Asked without the account, the provider-type rule refuses rather than guesses.
        expect(clientProviderDenial(client, "openai-subscription")).toContain("checked against the accounts");
    });

    it("a metered account needs the session's confirmation, and then a key of its own (never the environment's)", () => {
        const { record } = newSession({ grokProxyAccount: "work" });
        const unconfirmed: ResolvedClient = { name: "session", isOwner: false, session: record };

        expect(routeDenial(unconfirmed, metered)).toContain(
            "billed per token, and this session uses subscription accounts only"
        );
        expect(routeDenial(unconfirmed, metered)).toContain("--allow-metered work");

        const confirmed = updateSessionRecord(SESSION, (current) => {
            current.meteredConfirmed.push({ account: "work", confirmedAt: new Date().toISOString(), how: "flag" });
        });
        const client: ResolvedClient = { name: "session", isOwner: false, session: confirmed };

        expect(routeDenial(client, { ...metered, apiKeyEnv: "XAI_API_KEY", allowEnvApiKey: true })).toContain(
            "would spend a key from the proxy's environment"
        );
        expect(routeDenial(client, { ...metered, apiKey: "xai-test-key" })).toBeNull();
    });

    it("keeps the no-resale rule for ordinary client keys and the owner's full access", () => {
        expect(routeDenial(alice, codex)).toContain("owner-only");
        expect(routeDenial(alice, metered)).toBeNull();
        expect(routeDenial(owner, codex)).toBeNull();
    });
});

describe("sweepSessionRecords", () => {
    const START = 1_760_000_000_000;

    it("closes a record whose Claude process is gone or whose pid now belongs to a newer process", () => {
        newSession({ claudePid: 111, claudePidStartMs: START });
        createSessionRecord({ id: "b-recycled", codexProxyAccount: "codex", claudePid: 222, claudePidStartMs: START });
        createSessionRecord({ id: "c-running", codexProxyAccount: "codex", claudePid: 333, claudePidStartMs: START });
        const probe = {
            alive: (pid: number) => pid !== 111,
            startMs: (pid: number) => (pid === 222 ? START + 60_000 : START + 500),
        };

        const result = sweepSessionRecords({ probe });

        // readdir order differs per file system.
        expect(result.closed.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
            { id: SESSION, reason: "process-gone" },
            { id: "b-recycled", reason: "pid-recycled" },
        ]);
        expect(readSessionRecord(SESSION)?.closeReason).toBe("process-gone");
        expect(readSessionRecord("c-running")?.closedAt).toBeUndefined();
    });

    it("deletes closed records past the retention and keeps younger ones", () => {
        newSession();
        closeSessionRecord(SESSION);
        createSessionRecord({ id: "young", codexProxyAccount: "codex" });
        closeSessionRecord("young");
        updateSessionRecord(SESSION, (record) => {
            record.closedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
        });

        expect(sweepSessionRecords({ retentionDays: 30 }).pruned).toEqual([SESSION]);
        expect(existsSync(join(sessionsDir(), `${SESSION}.json`))).toBe(false);
        expect(readSessionRecord("young")).toBeDefined();
    });
});

describe("one session id per session", () => {
    it("a fork names its id on the first request; a different id later is logged and never re-keys", () => {
        const { record } = newSession({ forkPending: true });
        const forked = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";

        const named = noteSessionRequest(record, forked);
        expect(named.claudeSessionId).toBe(forked);
        expect(readSessionRecord(SESSION)?.forkPending).toBe(false);

        const later = noteSessionRequest(named, "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e");
        expect(later.claudeSessionId).toBe(forked);
        expect(requestTagsFor(new Headers(), later, undefined)?.session).toBe(forked);
    });

    it("tags a session's request with its id over any header; other clients keep x-gt-session, else their own id", () => {
        const { record } = newSession();
        const headers = new Headers({ "x-gt-session": "chosen", "x-gt-stage": "build" });

        expect(requestTagsFor(headers, record, "other")).toEqual({ session: SESSION, stage: "build" });
        expect(requestTagsFor(headers, undefined, SESSION)).toEqual({ session: "chosen", stage: "build" });
        expect(requestTagsFor(new Headers(), undefined, SESSION)).toEqual({ session: SESSION });
        expect(requestTagsFor(new Headers({ "thread-id": "codex-thread" }), undefined, undefined)).toEqual({
            session: "codex-thread",
        });
        expect(requestTagsFor(new Headers(), undefined, undefined)).toBeUndefined();
    });
});

describe("session view rows and stats", () => {
    const base: UsageRequestRecord = {
        ts: "2026-10-25T20:00:00.000Z",
        account: "codex",
        provider: "openai-subscription",
        proxyModel: "codex/codex/gpt-x:high",
        upstreamModel: "gpt-x",
        path: "/v1/messages",
        status: 200,
        elapsedMs: 1000,
        stream: true,
        tags: { session: SESSION },
    };

    it("splits each convention once: OpenAI cached tokens inside the prompt, Anthropic cache fields outside", () => {
        const codexRow = requestRow({
            ...base,
            usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_prompt_tokens: 900 },
        });
        const claudeRow = requestRow({
            ...base,
            provider: "anthropic-subscription",
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cache_read_input_tokens: 900 },
        });
        const oldRow = requestRow({
            ...base,
            usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
        });

        expect(codexRow).toMatchObject({ agent: "codex", effort: "high", input: 100, cacheRead: 900, hit: 90 });
        expect(claudeRow).toMatchObject({ agent: "claude", input: 100, cacheRead: 900, hit: 90 });
        expect(oldRow.cacheKnown).toBe(false);
    });

    it("takes the cache numbers of an old row from its transcript, also once the day was compressed to .zst", () => {
        const day = join(sessionsDir(), "..", "transcripts", "2026-10-24");
        mkdirSync(day, { recursive: true });
        const file = join(day, `${SESSION}.jsonl`);
        const entry = {
            uuid: "u-1",
            type: "assistant",
            message: { usage: { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1500 } } },
        };
        writeFileSync(
            `${file}.zst`,
            compressBytes(`${SafeJSON.stringify({ uuid: "u-0", type: "user" })}\n${SafeJSON.stringify(entry)}\n`)
        );

        const [row] = requestRows([
            {
                ...base,
                usage: { prompt_tokens: 2000, completion_tokens: 1, total_tokens: 2001 },
                transcript: { file, uuid: "u-1" },
            },
        ]);

        expect(row).toMatchObject({ cacheKnown: true, input: 500, cacheRead: 1500, hit: 75 });
    });

    it("stats per agent: hit over the known rows, losses inside each session by cause, rows without numbers counted apart", () => {
        const row = (minute: number, read: number, extra: Partial<UsageRequestRecord> = {}) =>
            requestRow({
                ...base,
                ts: new Date(Date.parse(base.ts) + minute * 60_000).toISOString(),
                usage: {
                    prompt_tokens: read + 100,
                    completion_tokens: 1,
                    total_tokens: read + 101,
                    cached_prompt_tokens: read,
                },
                ...extra,
            });
        const rows = [
            row(0, 50_000, { cacheKey: "a" }),
            row(1, 1_000, { cacheKey: "b" }),
            row(2, 1_000, { tags: { session: "other" } }),
            requestRow({ ...base, usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }),
        ];
        const [codex] = statsByAgent(rows);

        expect(codex).toMatchObject({ agent: "codex", requests: 4, unknownCache: 1, sessions: 2, losses: 1 });
        expect(codex.lossesByCause["key changed"]).toBe(1);
        expect(codex.hitPercent).toBeCloseTo((52_000 / 52_300) * 100, 6);
        expect(sinceToMs("7d", 1_000_000_000_000)).toBe(1_000_000_000_000 - 7 * 86_400_000);
        expect(() => sinceToMs("soon")).toThrow("--since");
    });
});
