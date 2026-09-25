import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisionBlocks } from "../decisions/read";
import { type DecisionRecord, postDecisions, readDecisions } from "../decisions/store";
import { dismissDecision, draftDecision, sendDrafts } from "./drafts";

function scratch(): { file: string; events: string } {
    const dir = mkdtempSync(join(tmpdir(), "gt-drafts-"));
    return { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
}

const ASK = ["❓ DECISION 3: Keep the cache?", "- a) keep it", "- b) drop it"].join("\n");
const block = () => parseDecisionBlocks(ASK)[0] ?? null;

describe("draftDecision", () => {
    test("a click marks the pick; a second clears it back to open; a note alone drafts", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ prompt: "Keep?", options: ["keep", "drop"] }],
        });
        const deps = { file, events, block: async () => block() };

        const picked = await draftDecision({ session: "s", number: 1, option: "a" }, deps);
        expect(picked).toMatchObject({ state: "drafted", draftOption: "a" });

        const cleared = await draftDecision({ session: "s", number: 1, option: "" }, deps);
        expect(cleared).toMatchObject({ state: "open" });
        expect(cleared?.draftOption ?? "").toBe("");

        const noted = await draftDecision({ session: "s", number: 1, text: "with a caveat" }, deps);
        expect(noted).toMatchObject({ state: "drafted", draft: "with a caveat" });
    });

    test("clearing a decision nobody picked yet leaves it open instead of failing", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ prompt: "Keep?", options: ["keep", "drop"] }],
        });
        const deps = { file, events, block: async () => block() };

        expect(await draftDecision({ session: "s", number: 1, option: "" }, deps)).toMatchObject({ state: "open" });
        expect(await draftDecision({ session: "s", number: 1, text: "  " }, deps)).toMatchObject({ state: "open" });
    });

    test("⌘-click adds a second letter", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ prompt: "Keep?", options: ["keep", "drop", "later"] }],
        });
        const deps = { file, events, block: async () => block() };

        await draftDecision({ session: "s", number: 1, option: "a" }, deps);
        const both = await draftDecision({ session: "s", number: 1, option: "ac" }, deps);
        expect(both?.draftOption).toBe("ac");
    });

    test("a transcript-only decision is harvested first, then drafted", async () => {
        const { file, events } = scratch();
        const deps = { file, events, block: async (_s: string, n: number) => (n === 3 ? block() : null) };

        const drafted = await draftDecision({ session: "s", number: 3, option: "b", provider: "claude" }, deps);
        expect(drafted).toMatchObject({ id: "d_3_s", state: "drafted", draftOption: "b", harvested: true });
        expect(readDecisions(file)).toHaveLength(1);
    });

    test("a letter past the options is refused before any write", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ prompt: "Keep?", options: ["keep", "drop"] }],
        });
        const deps = { file, events, block: async () => block() };

        await expect(draftDecision({ session: "s", number: 1, option: "c" }, deps)).rejects.toThrow("options a-b");
    });
});

describe("dismissDecision", () => {
    test("dismiss drops the decision without an answer, and it cannot be dismissed twice", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ prompt: "Probe?", options: ["a", "b"] }] });

        const gone = await dismissDecision({ session: "s", number: 1 }, { file, events });
        expect(gone).toMatchObject({ state: "dismissed" });
        expect(gone?.answer).toBeUndefined();

        await expect(dismissDecision({ session: "s", number: 1 }, { file, events })).rejects.toThrow(
            "already dismissed"
        );
    });
});

describe("sendDrafts", () => {
    test("promotes every drafted answer and delivers them as one message", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "s",
            decisions: [
                { prompt: "One?", options: ["a1", "b1"] },
                { prompt: "Two?", options: ["a2", "b2"] },
            ],
        });
        const deps = { file, events, block: async () => null };
        await draftDecision({ session: "s", number: 1, option: "a" }, deps);
        await draftDecision({ session: "s", number: 2, option: "b", text: "note" }, deps);

        const typed: string[][] = [];
        const target = {
            workspaceId: "ws",
            workspaceName: "agents",
            paneId: "pane:1",
            paneTitle: "agent",
            surfaceId: "surface:1",
            sessionIds: ["s"],
            matchedOn: "session-id",
            score: 90,
            active: true,
        };
        const result = await sendDrafts(
            { session: "s", provider: "claude" },
            {
                ...deps,
                deliver: {
                    runTool: async (args) => {
                        typed.push(args);
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                    findTargets: async () => ({ targets: [target], source: "titles", unavailable: false }) as never,
                },
            }
        );

        expect(result.promoted).toEqual([1, 2]);
        expect(result.channel).toBe("cmux");
        expect(typed[0]).toEqual(["claude", "cmux", "send", "s", "DECISION 1: a) a1 ; DECISION 2: b) note", "--json"]);
        const rows = readDecisions(file);
        expect(rows.every((row: DecisionRecord) => row.state === "sent")).toBe(true);
        expect(rows.every((row: DecisionRecord) => row.draftOption === undefined)).toBe(true);
    });

    test("the resume path waits for the reopened pane, then types into it", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ prompt: "One?", options: ["a1", "b1"] }] });
        const deps = { file, events, block: async () => null };
        await draftDecision({ session: "s", number: 1, option: "b" }, deps);

        let polls = 0;
        const slept: number[] = [];
        const typed: string[][] = [];
        const target = {
            workspaceId: "ws",
            workspaceName: "gt-inbox-scratch",
            paneId: "pane:9",
            paneTitle: "probe",
            surfaceId: "surface:9",
            sessionIds: ["s"],
            matchedOn: "session-id",
            score: 90,
            active: true,
        };
        const result = await sendDrafts(
            { session: "s", provider: "claude", recordResumeTarget: "cmux · new workspace", waitLiveMs: 5_000 },
            {
                ...deps,
                sleep: async (ms) => {
                    slept.push(ms);
                },
                deliver: {
                    // The pane is not live for the first two polls (claude is booting), then it is.
                    findTargets: async () =>
                        ++polls < 3
                            ? ({ targets: [], source: "none", unavailable: false } as never)
                            : ({ targets: [target], source: "titles", unavailable: false } as never),
                    runTool: async (args) => {
                        typed.push(args);
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                },
            }
        );

        expect(slept).toEqual([1000, 1000]);
        expect(typed).toEqual([["claude", "cmux", "send", "s", "DECISION 1: b) b1", "--json"]]);
        expect(result).toMatchObject({ channel: "cmux", delivered: true, target: "cmux · gt-inbox-scratch · probe" });
        expect(readDecisions(file)[0]).toMatchObject({ state: "sent", delivery: { route: "cmux" } });
    });

    test("the resume path queues the answers and records where it resumed, not an error", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ prompt: "One?", options: ["a1", "b1"] }] });
        const deps = { file, events, block: async () => null };
        await draftDecision({ session: "s", number: 1, option: "a" }, deps);

        const result = await sendDrafts(
            { session: "s", provider: "claude", recordResumeTarget: "cmux · new workspace" },
            {
                ...deps,
                deliver: {
                    runTool: async () => {
                        throw new Error("must not type on resume");
                    },
                },
            }
        );

        expect(result).toMatchObject({ channel: "resume", delivered: true, target: "cmux · new workspace" });
        const [row] = readDecisions(file);
        expect(row).toMatchObject({ state: "answered", delivery: { route: "resume", target: "cmux · new workspace" } });
    });
});
