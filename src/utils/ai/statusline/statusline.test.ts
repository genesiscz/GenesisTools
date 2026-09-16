import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeCodePayload } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/statusline";
import { StatuslineCache } from "./cache";
import { defaultStatuslineConfig, mergeStatuslineConfig } from "./config";
import { buildLine, visibleWidth } from "./layout";
import { renderStatusline } from "./render";
import {
    ANSI,
    accountSegment,
    contextSegment,
    deltaSegment,
    formatDeltaK,
    formatK,
    modelDisplayFromId,
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
            { name: "olivierson", fiveHour: 47, sevenDay: 28, sevenDayFable: 30, stale: false, fetchedAt: 1_000 },
            1_000 + 60_000
        );
        expect(fresh).toContain("⚿ oli…son");
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
        resolveModel: async () => "Opus 4.6",
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
        expect(first.lines[0]).toBe(`${ANSI.dim}O4.6${ANSI.reset} ${ANSI.blue}proj${ANSI.reset}`);
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
