import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAiProxyConfigStore, parseConfigJson, resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { getAiProxyStorage, resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const originalHome = env.get("GENESIS_TOOLS_HOME");

afterEach(() => {
    resetAiProxyConfigStore();
    resetAiProxyStorage();

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("sessionsIn config migration", () => {
    it("loads an old claudeSessions block as sessionsIn.claude, Claude Code knobs global, Codex knobs under codex", () => {
        const config = parseConfigJson(
            SafeJSON.stringify({
                claudeSessions: {
                    compaction: {
                        mode: "summary",
                        effort: "low",
                        words: 3000,
                        idle: false,
                        background: { enabled: false, startAt: 0.7 },
                    },
                    lead: { systemNote: { append: "Prefer terra for reviews." } },
                    subagents: {
                        systemNote: { prepend: "Be brief." },
                        skills: { nudge: false, allowed: ["simplify"] },
                    },
                },
            })
        );

        expect({ sessionsIn: config.sessionsIn, claudeSessions: config.claudeSessions }).toEqual({
            sessionsIn: {
                claude: {
                    global: {
                        compaction: { idle: false },
                        lead: { systemNote: { append: "Prefer terra for reviews." } },
                    },
                    providers: {
                        codex: {
                            compaction: {
                                mode: "summary",
                                effort: "low",
                                words: 3000,
                                background: { enabled: false, startAt: 0.7 },
                            },
                            subagents: {
                                systemNote: { prepend: "Be brief." },
                                skills: { nudge: false, allowed: ["simplify"] },
                            },
                        },
                    },
                },
            },
            claudeSessions: undefined,
        });
    });

    it("keeps the sessionsIn value where both shapes set the same key", () => {
        const config = parseConfigJson(
            SafeJSON.stringify({
                claudeSessions: { compaction: { mode: "summary", words: 3000 } },
                sessionsIn: { claude: { providers: { codex: { compaction: { mode: "native" } } } } },
            })
        );

        expect(config.sessionsIn?.claude?.providers?.codex?.compaction).toEqual({ mode: "native", words: 3000 });
    });

    it("adds no sessionsIn block to a config that has neither shape", () => {
        expect(parseConfigJson(SafeJSON.stringify({})).sessionsIn).toBeUndefined();
    });

    it("writes the new shape to disk on the next save, so the old key leaves config.json", async () => {
        const home = mkdtempSync(join(tmpdir(), "ai-proxy-sessions-in-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        resetAiProxyConfigStore();
        resetAiProxyStorage();

        try {
            const storage = getAiProxyStorage();
            await storage.ensureDirs();
            writeFileSync(
                storage.getConfigPath(),
                SafeJSON.stringify({ accounts: [], claudeSessions: { compaction: { idle: false, words: 1200 } } })
            );

            await getAiProxyConfigStore().mutate(() => {});

            const saved = SafeJSON.parse(readFileSync(storage.getConfigPath(), "utf8")) as Record<string, unknown>;
            expect({ sessionsIn: saved.sessionsIn, claudeSessions: saved.claudeSessions }).toEqual({
                sessionsIn: {
                    claude: {
                        global: { compaction: { idle: false } },
                        providers: { codex: { compaction: { words: 1200 } } },
                    },
                },
                claudeSessions: undefined,
            });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
