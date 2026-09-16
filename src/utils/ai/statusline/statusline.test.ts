import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import {
    accountFromPinJournal,
    accountNameFromPsDump,
    claudeCodeStatusline,
    parseClaudeCodePayload,
    parseInstalledCommand,
    resolveAccountName,
} from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/statusline";
import { env } from "@genesiscz/utils/env";
import * as gitCore from "@genesiscz/utils/git/core";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { isolatedPreviewCache, isolatedPreviewCacheDir, StatuslineCache } from "./cache";
import {
    defaultStatuslineConfig,
    formatStatuslineInstallCommand,
    loadStatuslineConfig,
    mergeStatuslineConfig,
    PREVIEW_SESSION_ID,
    previewRenderConfig,
    rememberPreviousCommand,
    saveStatuslineConfig,
} from "./config";
import { buildLine, visibleWidth } from "./layout";
import { gitInfo, renderStatusline } from "./render";
import {
    ANSI,
    accountSegment,
    contextSegment,
    deltaSegment,
    formatDeltaK,
    formatK,
    modelDisplayFromId,
    modelLabel,
    shortModel,
} from "./segments";
import type { StatuslineFeature } from "./types";

describe("statusline segments reproduce the shell script", () => {
    test("model ids map to display names and short forms", () => {
        expect(modelDisplayFromId("claude-opus-4-6-20260301")).toBe("Opus 4.6");
        expect(modelDisplayFromId("claude-sonnet-4-5")).toBe("Sonnet 4.5");
        expect(modelDisplayFromId("claude-fable-5-1")).toBe("Fable 5.1");
        expect(modelDisplayFromId("claude-opus-5")).toBe("Opus 5");
        expect(modelDisplayFromId("gpt-5")).toBe("gpt-5");
        expect(shortModel("Opus 4.6")).toBe("O4.6");
        expect(shortModel("Sonnet 4.5")).toBe("S4.5");
        expect(shortModel("Haiku 4.5")).toBe("H4.5");
        expect(shortModel("Claude")).toBe("Claude");
    });

    test("token formatting matches awk's %.0fk above 10k and %.1fk below", () => {
        expect(formatK(436_000)).toBe("436k");
        expect(formatK(9_950)).toBe("10.0k");
        expect(formatK(1_234)).toBe("1.2k");
        expect(formatDeltaK(512)).toBe("512");
        expect(formatDeltaK(1_500)).toBe("1.5k");
        expect(formatDeltaK(12_000)).toBe("12k");
    });

    test("context segment reserves 22.5% while autocompact is on", () => {
        const on = contextSegment({ usedTokens: 436_000, contextWindowSize: 1_000_000, autocompact: true });
        expect(on.usable).toBe(775_000);
        expect(on.usedPct).toBe(56);
        expect(on.context).toBe(` ${ANSI.yellow}436k/775k(56%)${ANSI.reset}`);
        expect(on.ac).toBe(` ${ANSI.dim}AC${ANSI.reset}`);

        const off = contextSegment({ usedTokens: 10_000, contextWindowSize: 200_000, autocompact: false });
        expect(off.usable).toBe(200_000);
        expect(off.context).toBe(` ${ANSI.green}10k/200k(5%)${ANSI.reset}`);
        expect(off.ac).toBe(` ${ANSI.dim}AC:OFF${ANSI.reset}`);
    });

    test("delta and account segments carry the script's colours and marks", () => {
        expect(deltaSegment(0)).toBe("");
        expect(deltaSegment(1_500)).toBe(` ${ANSI.green}+1.5k${ANSI.reset}`);
        expect(deltaSegment(-300)).toBe(` ${ANSI.red}-300${ANSI.reset}`);

        const fresh = accountSegment(
            { name: "abcdefghij", fiveHour: 47, sevenDay: 28, sevenDayFable: 30, stale: false, fetchedAt: 1_000 },
            1_000 + 60_000
        );
        expect(fresh).toContain("⚿ abc…hij");
        expect(fresh).toContain("47%");
        expect(fresh).toContain("F:");
        expect(fresh).not.toContain("⌁");

        const old = accountSegment(
            { name: "work", fiveHour: 90, sevenDay: 10, sevenDayFable: null, stale: false, fetchedAt: 1_000 },
            1_000 + 3_600_000
        );
        expect(old).toContain("⚿ work");
        expect(old).toContain("⌁!");

        const stale = accountSegment(
            { name: "work", fiveHour: null, sevenDay: 10, sevenDayFable: null, stale: true, fetchedAt: null },
            0
        );
        expect(stale).toContain("?%");
        expect(stale).toContain("⌁?");
    });

    test("layout drops parts that do not fit and measures visible width without ANSI", () => {
        expect(visibleWidth(`${ANSI.red}abc${ANSI.reset}`)).toBe(3);
        expect(buildLine(["12345", "67890", "x"], 6)).toBe("12345x");
    });
});

describe("Claude Code payload", () => {
    test("parses the fields the script read and flags a subagent frame", () => {
        const payload = parseClaudeCodePayload({
            workspace: { current_dir: "/repo", project_dir: "/repo" },
            session_id: "abcdef12-3456",
            transcript_path: "/nowhere.jsonl",
            model: { display_name: "Opus 5" },
            context_window: {
                context_window_size: 200_000,
                current_usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
            },
        });
        expect(payload?.cwd).toBe("/repo");
        expect(payload?.sessionId).toBe("abcdef12-3456");
        expect(payload?.usage).toEqual({ inputTokens: 1, cacheCreationTokens: 2, cacheReadTokens: 3 });
        expect(payload?.isAgentFrame).toBe(false);
        expect(parseClaudeCodePayload({ agent: { name: "worker" }, cwd: "/repo" })?.isAgentFrame).toBe(true);
        expect(parseClaudeCodePayload({})).toBeNull();
    });
});

describe("renderStatusline", () => {
    const feature: StatuslineFeature = {
        host: "Test Host",
        parsePayload: parseClaudeCodePayload,
        // `resolveModel` returns the model ID; the renderer decides how it reads.
        resolveModel: async () => "claude-opus-4-6",
        resolveLastMessageTime: async () => "12:45:13",
        resolveSessionName: async () => null,
        resolveAccount: async () => ({
            name: "work",
            fiveHour: 47,
            sevenDay: 28,
            sevenDayFable: null,
            stale: false,
            fetchedAt: Date.now(),
        }),
        resolveAutocompact: async () => true,
        settingsPath: () => "/dev/null",
        readInstalledCommand: async () => null,
        writeInstalledCommand: async () => {},
    };

    test("packs the script's two lines and tracks the token delta per session", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "statusline-cache-"));
        const cache = new StatuslineCache(cacheDir);
        const config = mergeStatuslineConfig(defaultStatuslineConfig(), {
            showGit: false,
            graft: { enabled: false, shim: "", ttlMs: 0 },
            metricsPost: { enabled: false, url: "", timeoutMs: 0 },
        });
        const raw = (used: number) => ({
            workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj" },
            session_id: "f0b20987-aaaa",
            context_window: {
                context_window_size: 1_000_000,
                current_usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
        });

        const first = await renderStatusline(raw(436_000), { feature, config, cache, columns: 120 });
        expect(first.lines).toHaveLength(2);
        expect(first.lines[0]).toBe(`${ANSI.dim}claude-opus-4-6${ANSI.reset} ${ANSI.blue}proj${ANSI.reset}`);
        expect(first.lines[1]).toContain("436k/775k(56%)");
        expect(first.lines[1]).toContain(`${ANSI.dim}AC${ANSI.reset}`);
        expect(first.lines[1]).toContain("f0b20987");
        expect(first.lines[1]).toContain("@12:45:13");
        expect(first.lines[1]).toContain("⚿ work");
        expect(first.lines[1]).not.toContain("+");

        const second = await renderStatusline(raw(437_500), { feature, config, cache, columns: 120 });
        expect(second.lines[1]).toContain(`${ANSI.green}+1.5k${ANSI.reset}`);
        expect(Object.keys(second.timings)).toContain("model");
        await second.settled;
    });

    test("a subagent frame renders nothing but the graft line", async () => {
        const config = mergeStatuslineConfig(defaultStatuslineConfig(), {
            graft: { enabled: false, shim: "", ttlMs: 0 },
        });
        const result = await renderStatusline(
            { agent: { name: "w" }, cwd: "/tmp/proj" },
            { feature, config, columns: 80 }
        );
        expect(result.lines).toEqual([]);
    });
});

describe("modelLabel", () => {
    /**
     * The default has to reproduce `~/.claude/statusline.sh`, which prints the raw id. The short
     * form stays available because it is narrower, but it is opt-in.
     */
    test("the default prints the id the shell script prints", () => {
        expect(modelLabel("claude-opus-5", "Opus 5", "id")).toBe("claude-opus-5");
    });

    test("the short form goes through the display mapping", () => {
        expect(modelLabel("claude-opus-5", "Opus 5", "short")).toBe("O5");
        expect(modelLabel("claude-sonnet-4-6", null, "short")).toBe("S4.6");
    });

    test("an unknown id falls back to the host's own label rather than inventing one", () => {
        expect(modelLabel(null, "Opus 5", "id")).toBe("Opus 5");
        expect(modelLabel(null, "Opus 5", "short")).toBe("O5");
        expect(modelLabel(null, null, "id")).toBe("Claude");
        expect(modelLabel(null, null, "short")).toBe("Claude");
    });
});

describe("dirty marker", () => {
    test("is off by default, because the shell script computes it and then wipes it", () => {
        expect(defaultStatuslineConfig().showDirty).toBe(false);
        expect(defaultStatuslineConfig().modelStyle).toBe("id");
        expect(defaultStatuslineConfig().metricsPost.enabled).toBe(false);
    });
});

describe("account truncation", () => {
    test("slices by code point so a leading emoji is not split mid-surrogate", () => {
        const rendered = accountSegment(
            {
                name: "😀abcdefgh",
                fiveHour: 10,
                sevenDay: 10,
                sevenDayFable: null,
                stale: false,
                fetchedAt: 1_000,
            },
            1_000
        );
        expect(rendered).toContain("😀ab…fgh");
    });
});

describe("cwd cache merge", () => {
    test("parallel git and graft patches both survive", async () => {
        const cache = new StatuslineCache(mkdtempSync(join(tmpdir(), "statusline-cwd-")));
        const cwd = "/repo";

        await Promise.all([
            Promise.resolve().then(() =>
                cache.writeCwdPatch(cwd, { branch: "feat", dirty: 0, at: 1, headMtime: 1, indexMtime: 1 })
            ),
            Promise.resolve().then(() => cache.writeCwdPatch(cwd, { graftLine: "graft-ok", graftAt: 2 })),
        ]);

        const entry = cache.cwd(cwd);
        expect(entry?.branch).toBe("feat");
        expect(entry?.graftLine).toBe("graft-ok");
    });
});

describe("gitInfo", () => {
    test("walks up from a subdirectory and does not call git status when showDirty is false", async () => {
        const repo = await TestRepo.create({ branch: "feat-sl" });
        mkdirSync(join(repo.dir, "packages", "nested"), { recursive: true });
        const spy = spyOn(gitCore, "createGit");
        const cache = new StatuslineCache(mkdtempSync(join(tmpdir(), "statusline-git-")));
        const config = mergeStatuslineConfig(defaultStatuslineConfig(), {
            showGit: true,
            showDirty: false,
            gitTtlMs: 0,
        });

        try {
            const info = await gitInfo(join(repo.dir, "packages", "nested"), config, cache, () => Date.now());
            expect(info?.branch).toBe("feat-sl");
            expect(info?.dirty).toBe(0);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
            repo.cleanup();
        }
    });

    test("resolves a linked worktree whose .git is a file", async () => {
        const repo = await TestRepo.create({ branch: "feat-sl" });
        await repo.git(["branch", "wt-branch"]);
        const worktree = await repo.worktreeAdd({ name: "wt", ref: "wt-branch" });
        const spy = spyOn(gitCore, "createGit");
        const cache = new StatuslineCache(mkdtempSync(join(tmpdir(), "statusline-wt-")));
        const config = mergeStatuslineConfig(defaultStatuslineConfig(), { showDirty: false, gitTtlMs: 0 });

        try {
            const info = await gitInfo(worktree, config, cache, () => Date.now());
            expect(info?.branch).toBe("wt-branch");
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
            repo.cleanup();
        }
    });

    test("porcelain runs only when showDirty is on", async () => {
        const repo = await TestRepo.create({ branch: "feat-sl" });
        repo.write({ file: "dirty.txt", content: "x\n" });
        const spy = spyOn(gitCore, "createGit");
        const cache = new StatuslineCache(mkdtempSync(join(tmpdir(), "statusline-dirty-")));
        const config = mergeStatuslineConfig(defaultStatuslineConfig(), { showDirty: true, gitTtlMs: 0 });

        try {
            const info = await gitInfo(repo.dir, config, cache, () => Date.now());
            expect(spy).toHaveBeenCalled();
            expect(info?.branch).toBe("feat-sl");
            expect(info?.dirty).toBeGreaterThan(0);
        } finally {
            spy.mockRestore();
            repo.cleanup();
        }
    });
});

describe("preview isolation", () => {
    test("does not write session files under the live cache dir", async () => {
        const liveDir = mkdtempSync(join(tmpdir(), "statusline-live-"));
        const liveCache = new StatuslineCache(liveDir);
        liveCache.writeSession("live-session", { prevTokens: 1 });
        const previewDir = isolatedPreviewCacheDir();
        const previewCache = isolatedPreviewCache(previewDir);
        const feature = claudeCodeStatusline(previewCache);
        const config = previewRenderConfig(
            mergeStatuslineConfig(defaultStatuslineConfig(), {
                showGit: false,
                graft: { enabled: false, shim: "", ttlMs: 0 },
            })
        );

        await renderStatusline(
            {
                workspace: { current_dir: "/tmp/proj", project_dir: "/tmp/proj" },
                session_id: PREVIEW_SESSION_ID,
                context_window: {
                    context_window_size: 200_000,
                    current_usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                },
            },
            { feature, config, cache: previewCache, columns: 80 }
        );

        expect(previewDir).not.toBe(aiDataDir("statusline", "cache"));
        expect(readdirSync(liveDir).filter((name) => name.startsWith("session-"))).toEqual([
            "session-live-session.json",
        ]);
        expect(readdirSync(liveDir).some((name) => name.includes("preview"))).toBe(false);
    });
});

describe("install previousCommand", () => {
    test("wizard save keeps the uninstall backup install just wrote", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "statusline-cfg-")), "config.json");
        const inMemory = defaultStatuslineConfig();
        const afterInstall = rememberPreviousCommand(inMemory, "bash /old/statusline.sh", false);
        await saveStatuslineConfig(afterInstall, path);
        const loaded = await loadStatuslineConfig(path);
        expect(loaded.previousCommand).toBe("bash /old/statusline.sh");

        const savedFromWizard = rememberPreviousCommand(
            { ...afterInstall, showDelta: false },
            "tools ai statusline run --claude",
            true
        );
        await saveStatuslineConfig(savedFromWizard, path);
        expect((await loadStatuslineConfig(path)).previousCommand).toBe("bash /old/statusline.sh");
    });

    test("the direct install command quotes paths that contain spaces", () => {
        const command = formatStatuslineInstallCommand({
            host: "claude",
            viaTools: false,
            bunPath: "/opt/bun runtime/bun",
            entryPath: "/tmp/My Tools/run.ts",
        });
        expect(command).toBe("'/opt/bun runtime/bun' '/tmp/My Tools/run.ts' '--claude'");
        expect(formatStatuslineInstallCommand({ host: "claude", viaTools: true })).toBe(
            "tools ai statusline run --claude"
        );
    });
});

describe("pin journal", () => {
    test("skips a torn line and keeps the newest Claude account", () => {
        const path = join(mkdtempSync(join(tmpdir(), "statusline-pins-")), "session-pins.jsonl");
        writeFileSync(
            path,
            [
                '{"sessionId":"abc","account":"first","at":1}',
                "{torn",
                '{"sessionId":"abc","account":"work laptop","provider":"claude","at":2}',
                '{"sessionId":"abc","account":"codex-acc","provider":"codex","at":3}',
                "",
            ].join("\n")
        );
        expect(accountFromPinJournal("abc", path)).toBe("work laptop");
    });
});

describe("account from env", () => {
    test("a name with a space survives the ps dump", () => {
        expect(accountNameFromPsDump("claude TOOLS_CLAUDE_ACCOUNT=work laptop PATH=/usr/bin")).toBe("work laptop");
    });

    test("the live process env is read through the env facade", async () => {
        const cache = new StatuslineCache(mkdtempSync(join(tmpdir(), "statusline-acct-")));
        const payload = parseClaudeCodePayload({
            workspace: { current_dir: "/tmp/proj" },
            session_id: "sess-1",
        });

        if (!payload) {
            throw new Error("expected a Claude Code payload");
        }

        await env.testing.withOverrides({ TOOLS_CLAUDE_ACCOUNT: "work laptop" }, () => {
            expect(resolveAccountName(payload, cache, Date.now())).toBe("work laptop");
        });
    });
});

describe("installed command settings", () => {
    test("a missing statusLine is null; unreadable JSON is not treated as absent", () => {
        expect(parseInstalledCommand("{}")).toBeNull();
        expect(
            parseInstalledCommand('{"statusLine":{"type":"command","command":"tools ai statusline run --claude"}}')
        ).toBe("tools ai statusline run --claude");
        expect(() => parseInstalledCommand("{")).toThrow(/unreadable JSON/);
    });
});
