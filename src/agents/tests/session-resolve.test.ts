import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { resolveSession } from "../lib/session-resolve";

describe("resolveSession", () => {
    test("explicit --session wins over env", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-sess-"));

        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_HOME: home,
                GENESIS_AGENTS_SESSION: "from-env",
                CLAUDE_CODE_SESSION_ID: "from-claude",
            },
            () => {
                const resolved = resolveSession("explicit-id");
                expect(resolved.session).toBe("explicit-id");
                expect(resolved.source).toBe("explicit");
            }
        );
    });

    test("prefers GENESIS_AGENTS_SESSION over CLAUDE_CODE_SESSION_ID", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-sess-"));

        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_HOME: home,
                GENESIS_AGENTS_SESSION: "from-gt",
                CLAUDE_CODE_SESSION_ID: "from-claude",
                GROK_SESSION_ID: "from-grok",
            },
            () => {
                const resolved = resolveSession(undefined);
                expect(resolved.session).toBe("from-gt");
                expect(resolved.source).toBe("env");
            }
        );
    });

    test("falls back to GROK_SESSION_ID when the others are unset", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-sess-"));

        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_HOME: home,
                GENESIS_AGENTS_SESSION: undefined,
                CLAUDE_CODE_SESSION_ID: undefined,
                GROK_SESSION_ID: "from-grok",
            },
            () => {
                const resolved = resolveSession(undefined);
                expect(resolved.session).toBe("from-grok");
                expect(resolved.source).toBe("env");
            }
        );
    });

    test("binds to the only recent session when env is empty", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-sess-"));
        const sessionDir = join(home, ".genesis-tools", "agents", "only-recent");
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, "feed.jsonl"), "{}\n");

        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_HOME: home,
                GENESIS_AGENTS_SESSION: undefined,
                CLAUDE_CODE_SESSION_ID: undefined,
                GROK_SESSION_ID: undefined,
            },
            () => {
                const resolved = resolveSession(undefined);
                expect(resolved.session).toBe("only-recent");
                expect(resolved.source).toBe("single-recent");
            }
        );
    });
});
