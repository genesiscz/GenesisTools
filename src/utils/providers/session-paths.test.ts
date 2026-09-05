import { describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import {
    isNativeTranscript,
    nativeSessionRoots,
    nativeSessionRootsForHome,
    nativeTranscriptMaxDepth,
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
