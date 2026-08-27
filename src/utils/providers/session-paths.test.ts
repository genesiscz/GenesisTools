import { describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { isNativeTranscript, nativeSessionRoots, nativeTranscriptMaxDepth } from "./session-paths";

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
        expect(nativeSessionRoots("grok", "/home/u")).toEqual(["/home/u/.grok/sessions"]);
        await env.testing.withOverrides({ GROK_HOME: "/elsewhere/grok" }, () => {
            expect(nativeSessionRoots("grok", "/home/u")).toEqual(["/elsewhere/grok/sessions"]);
        });
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
