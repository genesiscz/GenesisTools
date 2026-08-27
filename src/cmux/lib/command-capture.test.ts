import { describe, expect, test } from "bun:test";
import { cleanLaunchCommand, deriveReplayCommand } from "@app/cmux/lib/command-capture";

describe("cleanLaunchCommand", () => {
    test("strips the bun wrapper down to `tools`", () => {
        expect(cleanLaunchCommand("bun /Users/x/Projects/GenesisTools/tools cc run foltyn --resume burn")).toBe(
            "tools cc run foltyn --resume burn"
        );
        expect(cleanLaunchCommand("/Users/x/.bun/bin/bun run /repo/tools cc run a")).toBe("tools cc run a");
    });

    test("normalizes an absolute grok path", () => {
        expect(cleanLaunchCommand("/Users/x/.local/bin/grok --resume")).toBe("grok --resume");
    });

    test("leaves ordinary commands alone", () => {
        expect(cleanLaunchCommand("vim notes.md")).toBe("vim notes.md");
    });
});

describe("deriveReplayCommand", () => {
    const sessionId = "aa45fee8-9a3b-4745-83d2-89a4445092b7";

    test("non-claude commands pass through with no drift", () => {
        const result = deriveReplayCommand({ original: "grok --resume", sessionId, account: "work" });
        expect(result.command).toBe("grok --resume");
        expect(result.drift).toEqual([]);
    });

    test("without a session id the original is kept verbatim", () => {
        const result = deriveReplayCommand({ original: "tools cc run work --resume burn" });
        expect(result.command).toBe("tools cc run work --resume burn");
        expect(result.drift).toEqual([]);
    });

    test("adds the pinned account and flags the drift when the original had none", () => {
        const result = deriveReplayCommand({ original: "tools cc run", sessionId, account: "work" });
        expect(result.command).toBe(`tools cc run work -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('account "work" added'))).toBe(true);
    });

    test("keeps the original explicit account over the pinned one", () => {
        const result = deriveReplayCommand({
            original: "tools cc run personal --resume burn",
            sessionId,
            account: "work",
        });
        expect(result.command).toBe(`tools cc run personal -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('resume target "burn" replaced'))).toBe(true);
        expect(result.drift.some((d) => d.includes("account"))).toBe(false);
    });

    test("flags a bare --resume picker being replaced", () => {
        const result = deriveReplayCommand({ original: "tools cc run work --resume", sessionId, account: "work" });
        expect(result.command).toBe(`tools cc run work -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("bare --resume"))).toBe(true);
    });

    test("bare claude launchers keep the launcher and other flags, only pinning the resume target", () => {
        const result = deriveReplayCommand({
            original: "claude --model opus --resume burn",
            sessionId,
            account: "work",
        });
        expect(result.command).toBe(`claude --model opus --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes('resume target "burn" replaced'))).toBe(true);
    });

    test("bare claude without --resume gets one appended", () => {
        const result = deriveReplayCommand({ original: "claude --model opus", sessionId });
        expect(result.command).toBe(`claude --model opus --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("added"))).toBe(true);
    });

    test("bare claude already resuming the right session passes through with no drift", () => {
        const result = deriveReplayCommand({ original: `claude --resume ${sessionId}`, sessionId });
        expect(result.command).toBe(`claude --resume ${sessionId}`);
        expect(result.drift).toEqual([]);
    });

    test("without any account the command defers to cc run's own prompt and says so", () => {
        const result = deriveReplayCommand({ original: "tools cc run", sessionId });
        expect(result.command).toBe(`tools cc run -- --resume ${sessionId}`);
        expect(result.drift.some((d) => d.includes("no account recorded"))).toBe(true);
    });
});

describe("etimeToSeconds", () => {
    test("parses mm:ss, hh:mm:ss and dd-hh:mm:ss", async () => {
        const { etimeToSeconds } = await import("@app/cmux/lib/command-capture");
        expect(etimeToSeconds("00:05")).toBe(5);
        expect(etimeToSeconds("01:02:03")).toBe(3723);
        expect(etimeToSeconds("2-01:00:00")).toBe(176400);
        expect(etimeToSeconds("garbage")).toBe(0);
    });
});
