import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_CACHE_TTL_MS, computeCacheStatus, GROK_CACHE_TTL_MS } from "@app/claude/lib/usage/session-rows";
import {
    claudeHistoryReader,
    codexHistoryReader,
    grokHistoryReader,
} from "@genesiscz/utils/agent-sessions/compact-readers";
import * as historyCatalog from "@genesiscz/utils/agent-sessions/open-service";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { type AgentSessionRow, cmuxLocationForRow, listAgentSessionRows } from "./agent-session-rows";

/**
 * The contract this file pins is the ROW SHAPE, because a reader outside this repo (the
 * Genesis menu-bar app) decodes it. A `cacheTtlSec` of 0 reads as "the prompt cache expired
 * right now", which is a wrong answer where an absent field is an honest one. Claude, Codex
 * and Grok now all report a clock; a payload that omits the keys must still decode as absent
 * on the Swift side, which is a Genesis test, not this one.
 */

function coolingRow(provider: AgentSessionRow["provider"], ttlMs: number): AgentSessionRow {
    const now = 1_800_000_000_000;
    const lastCacheAt = now - 20 * 60 * 1000;
    const { status, ttlSec } = computeCacheStatus(lastCacheAt, now, ttlMs);

    return {
        provider,
        sessionId: `01a0-${provider}`,
        title: "rewind-improvements",
        cwd: "/projects/rewind",
        cwdShort: "~/projects/rewind",
        project: "rewind",
        mtime: lastCacheAt,
        lastCacheAt,
        model: null,
        account: null,
        filePath: `/home/.${provider}/sessions/x.jsonl`,
        sourceHome: `/home/.${provider}`,
        archived: false,
        cacheStatus: status,
        cacheTtlSec: ttlSec,
        cacheLifetimeSec: Math.ceil(ttlMs / 1000),
    };
}

test("a codex row reports the 30-minute subscription cache clock", () => {
    const row = coolingRow("codex", CODEX_CACHE_TTL_MS);
    expect(row.cacheStatus).toBe("COOLING");
    expect(row.cacheTtlSec).toBe(600);
    expect(row.cacheLifetimeSec).toBe(1800);
    expect("contextTokens" in row).toBe(false);
});

test("a grok row reports the 30-minute warning clock", () => {
    const row = coolingRow("grok", GROK_CACHE_TTL_MS);
    expect(row.cacheStatus).toBe("COOLING");
    expect(row.cacheTtlSec).toBe(600);
    expect(row.cacheLifetimeSec).toBe(1800);
    expect("contextTokens" in row).toBe(false);
});

test("a codex row's account is nullable, because Codex itself records none", () => {
    // Every Codex account shares one home, and neither a rollout's session_meta nor a `threads`
    // row carries an account. The SessionStart pin journal is the only record, so a session
    // started outside `tools codex run` — or before the hook learned about Codex — has none.
    const row: AgentSessionRow = {
        provider: "codex",
        sessionId: "01a0-codex",
        title: "rewind-improvements",
        cwd: "/projects/rewind",
        cwdShort: "~/projects/rewind",
        project: "rewind",
        mtime: 1_000,
        model: null,
        account: null,
        filePath: "/home/.codex/sessions/x.jsonl",
        sourceHome: "/home/.codex",
        archived: false,
    };

    expect(row.account).toBeNull();
    expect(row.sourceHome).toBe("/home/.codex");

    const pinned: AgentSessionRow = { ...row, account: "work" };
    expect(pinned.account).toBe("work");
});

test("a claude row is the same shape with the extra fields filled", () => {
    const claudeRow: AgentSessionRow = {
        provider: "claude",
        sessionId: "01a0-claude",
        title: "rewind-improvements",
        cwd: "/projects/rewind",
        cwdShort: "~/projects/rewind",
        project: "rewind",
        mtime: 1_000,
        lastCacheAt: 1_000,
        model: "opus",
        account: "work",
        filePath: "/home/.claude/x.jsonl",
        cacheStatus: "HOT",
        cacheTtlSec: 3_400,
        cacheLifetimeSec: 3600,
        contextTokens: 505_000,
        cmux: null,
    };

    expect(claudeRow.provider).toBe("claude");
    expect(claudeRow.cacheStatus).toBe("HOT");
    expect(claudeRow.cacheLifetimeSec).toBe(3600);
    expect(claudeRow.contextTokens).toBe(505_000);
});

test("a grok row takes a grok journal line and ignores an untagged or claude one", () => {
    const grokId = "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const location = {
        workspaceId: "ws",
        surfaceId: "surface-1",
        workspaceRef: null,
        paneRef: null,
        surfaceRef: "surface:1",
        windowRef: null,
        tmuxPane: null,
        cwd: "/tmp/grok-session",
        at: 10,
    };
    const refs = new Map<string, SessionCmuxRefs>([
        [grokId, { ...location, sessionId: grokId, provider: "grok" }],
        ["untagged", { ...location, sessionId: "untagged", surfaceId: "surface-2" }],
        ["claude-id", { ...location, sessionId: "claude-id", provider: "claude", surfaceId: "surface-3" }],
    ]);

    expect(cmuxLocationForRow(grokId, "grok", refs)?.surfaceId).toBe("surface-1");
    expect(cmuxLocationForRow("untagged", "grok", refs)).toBeNull();
    expect(cmuxLocationForRow("claude-id", "grok", refs)).toBeNull();
    expect(cmuxLocationForRow(grokId, "claude", refs)).toBeNull();
});

test("a codex row takes an untagged journal line with a codex id", () => {
    const codexId = "019a0aaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const refs = new Map<string, SessionCmuxRefs>([
        [
            codexId,
            {
                sessionId: codexId,
                workspaceId: "ws",
                surfaceId: "surface-9",
                workspaceRef: null,
                paneRef: null,
                surfaceRef: "surface:9",
                windowRef: null,
                tmuxPane: null,
                cwd: "/tmp/codex-session",
                at: 10,
            },
        ],
    ]);

    expect(cmuxLocationForRow(codexId, "codex", refs)?.surfaceId).toBe("surface-9");
    expect(cmuxLocationForRow(codexId, "grok", refs)).toBeNull();
});

test("exact transcript paths reach both provider catalogs before row hydration", async () => {
    const filePaths = ["/fixture/claude.jsonl", "/fixture/codex.jsonl"];
    const catalog = spyOn(historyCatalog, "catalogHistory").mockResolvedValue({
        metadata: [],
        reindexed: false,
        report: { sessions: 0, messages: null, sources: 0, issues: [], parsed: 0, unchanged: 0, removed: 0 },
    });
    try {
        expect(await listAgentSessionRows({ providers: ["claude", "codex"], filePaths, refresh: false })).toEqual([]);
        expect(catalog).toHaveBeenCalledTimes(2);
        expect(catalog.mock.calls.map(([options]) => options.provider).sort()).toEqual(["claude", "openai-sub"]);
        for (const [options] of catalog.mock.calls) {
            expect(options.filters?.filePaths).toEqual(filePaths);
            expect(options.refresh).toBe(false);
        }
    } finally {
        catalog.mockRestore();
    }
});

test("a mixed Claude and Codex exact-path listing never walks either history root", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-rows-mixed-")));
    const claudeRoot = join(home, "claude", "projects");
    const codexRoot = join(home, "codex", "sessions");
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
    const claudeId = "11111111-2222-4333-8444-000000000051";
    const codexId = "11111111-2222-4333-8444-000000000052";
    const claudePath = join(claudeRoot, `${claudeId}.jsonl`);
    const codexPath = join(codexRoot, `rollout-${codexId}.jsonl`);
    writeFileSync(
        claudePath,
        `${SafeJSON.stringify({
            type: "user",
            sessionId: claudeId,
            cwd: "/projects/fixture",
            timestamp: "2026-10-17T00:00:00Z",
            message: { content: "fixture" },
        })}\n`
    );
    writeFileSync(
        codexPath,
        `${SafeJSON.stringify({
            type: "session_meta",
            payload: {
                id: codexId,
                cwd: "/projects/fixture",
                history_mode: "legacy",
            },
        })}\n`
    );
    const claude = spyOn(claudeHistoryReader, "roots").mockReturnValue([claudeRoot]);
    const codex = spyOn(codexHistoryReader, "roots").mockReturnValue([codexRoot]);
    const grok = spyOn(grokHistoryReader, "roots").mockReturnValue([]);
    const directories = spyOn(fsPromises, "readdir");
    try {
        const rows = await listAgentSessionRows({
            providers: ["claude", "codex"],
            filePaths: [claudePath, codexPath],
            withUsage: false,
        });
        expect(rows.map((row) => row.sessionId).sort()).toEqual([claudeId, codexId]);
        expect(
            directories.mock.calls.filter(
                ([directory]) => String(directory).startsWith(claudeRoot) || String(directory).startsWith(codexRoot)
            )
        ).toEqual([]);
        directories.mockClear();
        expect(
            await listAgentSessionRows({
                providers: ["claude"],
                filePaths: [codexPath],
                withUsage: false,
            })
        ).toEqual([]);
        expect(directories.mock.calls.filter(([directory]) => String(directory).startsWith(claudeRoot))).toEqual([]);
    } finally {
        directories.mockRestore();
        claude.mockRestore();
        codex.mockRestore();
        grok.mockRestore();
        rmSync(home, { recursive: true, force: true });
    }
});

test("throwing provider roots stay inside that provider's failure boundary", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-rows-root-failure-")));
    const root = join(home, "claude", "projects");
    mkdirSync(root, { recursive: true });
    const id = "11111111-2222-4333-8444-000000000061";
    const file = join(root, `${id}.jsonl`);
    writeFileSync(
        file,
        `${SafeJSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/projects/fixture",
            message: { content: "fixture" },
        })}\n`
    );
    const claude = spyOn(claudeHistoryReader, "roots").mockReturnValue([root]);
    const codex = spyOn(codexHistoryReader, "roots").mockImplementation(() => {
        throw new Error("Codex roots unavailable");
    });
    const grok = spyOn(grokHistoryReader, "roots").mockReturnValue([]);
    try {
        for (const failClosed of [false, true]) {
            const rows = await listAgentSessionRows({
                providers: ["claude"],
                filePaths: [file],
                withUsage: false,
                failClosed,
            });
            expect(rows.map((row) => row.sessionId)).toEqual([id]);
        }
        const available = await listAgentSessionRows({
            providers: ["claude", "codex"],
            filePaths: [file],
            withUsage: false,
        });
        expect(available.map((row) => row.sessionId)).toEqual([id]);
        await expect(
            listAgentSessionRows({
                providers: ["claude", "codex"],
                filePaths: [file],
                withUsage: false,
                failClosed: true,
            })
        ).rejects.toThrow("Codex roots unavailable");
    } finally {
        claude.mockRestore();
        codex.mockRestore();
        grok.mockRestore();
        rmSync(home, { recursive: true, force: true });
    }
});

test.each(["logical", "canonical"] as const)("a %s request retains a Claude link into Codex roots", async (request) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-rows-cross-provider-link-")));
    const claudeRoot = join(home, "claude", "projects");
    const codexRoot = join(home, "codex", "sessions");
    mkdirSync(claudeRoot, { recursive: true });
    mkdirSync(codexRoot, { recursive: true });
    const id = "11111111-2222-4333-8444-000000000062";
    const target = join(codexRoot, `rollout-${id}.jsonl`);
    const link = join(claudeRoot, `${id}.jsonl`);
    writeFileSync(
        target,
        `${SafeJSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/projects/fixture",
            message: { content: "linked fixture" },
        })}\n`
    );
    symlinkSync(target, link);
    const claude = spyOn(claudeHistoryReader, "roots").mockReturnValue([claudeRoot]);
    const codex = spyOn(codexHistoryReader, "roots").mockReturnValue([codexRoot]);
    const grok = spyOn(grokHistoryReader, "roots").mockReturnValue([]);
    try {
        // A canonical request uses the root association recorded by a normal refresh; a logical one is cold.
        if (request === "canonical") {
            await historyCatalog.catalogHistory({ provider: "claude", roots: [claudeRoot] });
        }
        const rows = await listAgentSessionRows({
            providers: ["claude"],
            filePaths: [request === "logical" ? link : target],
            withUsage: false,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ provider: "claude", sessionId: id, filePath: target });
    } finally {
        claude.mockRestore();
        codex.mockRestore();
        grok.mockRestore();
        rmSync(home, { recursive: true, force: true });
    }
});

test("a provider that cannot be listed adds no rows, or with failClosed fails the listing", async () => {
    // A file where the tools home should be: the history index cannot be opened, so the provider throws.
    const home = join(mkdtempSync(join(tmpdir(), "agent-rows-home-")), "not-a-folder");
    writeFileSync(home, "");
    env.testing.set("GENESIS_TOOLS_HOME", home);

    try {
        expect(await listAgentSessionRows({ providers: ["codex"], hours: 1 })).toEqual([]);
        await expect(listAgentSessionRows({ providers: ["codex"], hours: 1, failClosed: true })).rejects.toThrow();
    } finally {
        env.testing.unset("GENESIS_TOOLS_HOME");
    }
});
