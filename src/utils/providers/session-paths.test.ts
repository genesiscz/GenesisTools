import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    codexHomeOverrides,
    codexHomesIn,
    isNativeTranscript,
    nativeSessionRoots,
    nativeSessionRootsForHome,
    nativeTranscriptMaxDepth,
    primaryCodexHome,
} from "./session-paths";

describe("nativeSessionRoots", () => {
    test("claude lists the default projects dirs plus CLAUDE_CONFIG_DIR", async () => {
        expect(nativeSessionRoots("claude", "/home/u")).toEqual([
            "/home/u/.claude/projects",
            "/home/u/.config/claude/projects",
        ]);
        await env.testing.withOverrides({ CLAUDE_CONFIG_DIR: "/custom/claude" }, () => {
            expect(nativeSessionRoots("claude", "/home/u")).toEqual([
                "/home/u/.claude/projects",
                "/home/u/.config/claude/projects",
                "/custom/claude/projects",
            ]);
        });
    });

    test("grok is ~/.grok/sessions and GROK_HOME moves it", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "/gt" }, () => {
            expect(nativeSessionRoots("grok", "/home/u")).toEqual([
                "/home/u/.grok/sessions",
                "/gt/.genesis-tools/grok/worker-home/sessions",
            ]);
        });
        await env.testing.withOverrides({ GROK_HOME: "/elsewhere/grok", GENESIS_TOOLS_HOME: "/gt" }, () => {
            expect(nativeSessionRoots("grok", "/home/u")).toEqual([
                "/elsewhere/grok/sessions",
                "/gt/.genesis-tools/grok/worker-home/sessions",
            ]);
        });
    });

    test("the headless worker home is listed, so `tools grok run` sessions are readable", async () => {
        // The worker pins GROK_HOME to an isolated directory that never reaches
        // the user's shell, so this root is the only way a reader finds them.
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "/gt" }, () => {
            expect(nativeSessionRoots("grok", "/home/u")).toContain("/gt/.genesis-tools/grok/worker-home/sessions");
        });
    });

    test("no duplicate root when GROK_HOME already points at the worker home", async () => {
        await env.testing.withOverrides(
            { GENESIS_TOOLS_HOME: "/gt", GROK_HOME: "/gt/.genesis-tools/grok/worker-home" },
            () => {
                expect(nativeSessionRoots("grok", "/home/u")).toEqual(["/gt/.genesis-tools/grok/worker-home/sessions"]);
            }
        );
    });

    test("codex follows CODEX_HOME, comma-separated, sessions + archived_sessions", async () => {
        expect(nativeSessionRoots("codex", "/home/u")).toEqual([
            "/home/u/.codex/sessions",
            "/home/u/.codex/archived_sessions",
        ]);
        await env.testing.withOverrides({ CODEX_HOME: "/a/codex, /b/codex" }, () => {
            expect(nativeSessionRoots("codex", "/home/u")).toEqual([
                "/a/codex/sessions",
                "/a/codex/archived_sessions",
                "/b/codex/sessions",
                "/b/codex/archived_sessions",
            ]);
        });
    });
});

describe("nativeSessionRootsForHome", () => {
    test("codex is sessions + archived_sessions under the given home", () => {
        expect(nativeSessionRootsForHome("codex", "/a/work")).toEqual([
            "/a/work/sessions",
            "/a/work/archived_sessions",
        ]);
    });

    test("grok is sessions only, and never appends the headless worker home", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "/gt" }, () => {
            expect(nativeSessionRootsForHome("grok", "/a/grok-work")).toEqual(["/a/grok-work/sessions"]);
        });
    });

    test("claude is the projects dir of that home", () => {
        expect(nativeSessionRootsForHome("claude", "/a/claude")).toEqual(["/a/claude/projects"]);
    });

    test("the ambient home overrides are ignored — the caller already named the home", async () => {
        await env.testing.withOverrides(
            { CODEX_HOME: "/elsewhere/codex", GROK_HOME: "/elsewhere/grok", CLAUDE_CONFIG_DIR: "/elsewhere/claude" },
            () => {
                expect(nativeSessionRootsForHome("codex", "/a/work")).toEqual([
                    "/a/work/sessions",
                    "/a/work/archived_sessions",
                ]);
                expect(nativeSessionRootsForHome("grok", "/a/grok")).toEqual(["/a/grok/sessions"]);
                expect(nativeSessionRootsForHome("claude", "/a/claude")).toEqual(["/a/claude/projects"]);
            }
        );
    });

    test("negative control: nativeSessionRoots still honours the CODEX_HOME comma list", async () => {
        await env.testing.withOverrides({ CODEX_HOME: "/a/codex, /b/codex" }, () => {
            expect(nativeSessionRoots("codex", "/home/u")).toEqual([
                "/a/codex/sessions",
                "/a/codex/archived_sessions",
                "/b/codex/sessions",
                "/b/codex/archived_sessions",
            ]);
        });
    });
});

describe("isNativeTranscript", () => {
    test("grok only accepts updates.jsonl", () => {
        expect(isNativeTranscript("grok", "updates.jsonl")).toBe(true);
        expect(isNativeTranscript("grok", "events.jsonl")).toBe(false);
        expect(isNativeTranscript("claude", "abc.jsonl")).toBe(true);
        expect(isNativeTranscript("codex", "rollout.jsonl")).toBe(true);
    });
});

describe("nativeTranscriptMaxDepth", () => {
    test("matches the known CLI layouts", () => {
        expect(nativeTranscriptMaxDepth("claude")).toBe(6);
        expect(nativeTranscriptMaxDepth("grok")).toBe(3);
        expect(nativeTranscriptMaxDepth("codex")).toBe(4);
    });
});
describe("codexHomesIn", () => {
    test("takes the real home and hyphenated profile homes, and a dotted backup of a codex home is not a home", () => {
        const root = mkdtempSync(join(tmpdir(), "codex-homes-"));
        for (const name of [
            ".codex",
            ".codex-personal",
            ".codex-shop",
            ".codex.bak-2026-01-01",
            ".codexbar",
            ".claude",
        ]) {
            mkdirSync(join(root, name));
        }

        expect(codexHomesIn(root)).toEqual([
            join(root, ".codex"),
            join(root, ".codex-personal"),
            join(root, ".codex-shop"),
        ]);
    });

    test("an absent root has no homes", () => {
        expect(codexHomesIn(join(tmpdir(), "codex-homes-absent-does-not-exist"))).toEqual([]);
    });
});

describe("codexHomeOverrides", () => {
    test("a comma list becomes one entry per home, trimmed", async () => {
        await env.testing.withOverrides({ CODEX_HOME: "/a/codex, /b/codex ,, " }, () => {
            expect(codexHomeOverrides()).toEqual(["/a/codex", "/b/codex"]);
        });
    });

    test("an unset variable answers with nothing at all", async () => {
        await env.testing.withOverrides({ CODEX_HOME: "" }, () => {
            expect(codexHomeOverrides()).toEqual([]);
            expect(primaryCodexHome()).toBeUndefined();
        });
    });

    test("the primary home is the first entry, never the whole string", async () => {
        // `join(raw, "auth.json")` and `resolve(raw)` both produced one directory named
        // `/a/codex,/b/codex`, which nothing on disk answers to: `tools codex spawn` recorded
        // it as the session home and `--import-native` reported no native credential.
        await env.testing.withOverrides({ CODEX_HOME: "/a/codex,/b/codex" }, () => {
            expect(primaryCodexHome()).toBe("/a/codex");
        });
    });

    test("a single home is still that home", async () => {
        await env.testing.withOverrides({ CODEX_HOME: "/only/codex" }, () => {
            expect(primaryCodexHome()).toBe("/only/codex");
        });
    });
});
