import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { answerGitWithoutSpawning } from "@genesiscz/utils/test/no-git";
import { deliverDecisions, parseDecisionBlocks } from "../decisions/read";
import {
    type DecisionRecord,
    postDecisions,
    readDecisions,
    reservePromptDecisions,
    updateDecisions,
} from "../decisions/store";
import { dismissDecision, draftDecision, sendDrafts, stagedSendText } from "./drafts";

// A decision post reads its checkout with eight `git` starts; see no-git.ts for the CI hang they caused.
answerGitWithoutSpawning();

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
    test("in session: answers stay retryable until the exact submitted prompt is acknowledged", async () => {
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
        await draftDecision({ session: "s", number: 2, text: "my own words" }, deps);
        // The mods Decisions sidebar shows this above its [send]: it must be what the send submits.
        const preview = stagedSendText(readDecisions(file), "s");

        const result = await sendDrafts(
            { session: "s", provider: "claude", inSession: true },
            {
                ...deps,
                deliver: {
                    runTool: async () => {
                        throw new Error("an in-session send must type nothing");
                    },
                },
            }
        );

        expect(result.promoted).toEqual([1, 2]);
        expect(result.channel).toBe("prompt");
        expect(result.text).toBe("DECISION 1: a) a1\nDECISION 2: my own words");
        expect(preview).toBe(result.text);
        expect(result.delivered).toBe(false);
        expect(result.numbers).toEqual([]);
        expect(readDecisions(file).every((row) => row.state === "answered" && !row.delivery)).toBe(true);
        // Preparing owns the batch before host.submit can trigger injection or another sender.
        await expect(sendDrafts({ session: "s", inSession: true }, deps)).rejects.toThrow("nothing to send");
        expect(() => deliverDecisions(readDecisions(file), () => undefined)).toThrow("nothing to send");
        expect(stagedSendText(readDecisions(file), "s")).toBeUndefined();
        const ack = await sendDrafts({ session: "s", promptReceipt: result.promptReceipt }, deps);
        expect(ack).toMatchObject({ delivered: true, channel: "prompt", numbers: [1, 2] });
        expect(stagedSendText(readDecisions(file), "s")).toBeUndefined();
        const rows = readDecisions(file);
        expect(rows.map((row) => [row.state, row.delivery?.route])).toEqual([
            ["sent", "prompt"],
            ["sent", "prompt"],
        ]);
    });

    test("prompt acknowledgement validates its receipt, keeps its lease on failure and never promotes newer drafts", async () => {
        const deps = { ...scratch(), block: async () => null };
        await postDecisions(deps.file, deps.events, {
            sessionId: "s",
            decisions: [
                { prompt: "One?", options: ["one", "two"] },
                { prompt: "New?", options: ["yes", "no"] },
            ],
        });
        await draftDecision({ session: "s", number: 1, option: "a" }, deps);
        const prepared = await sendDrafts({ session: "s", inSession: true }, deps);
        await draftDecision({ session: "s", number: 2, option: "b" }, deps);
        const first = readDecisions(deps.file)[0];
        await expect(
            updateDecisions(deps.file, deps.events, { updates: [{ id: first.id, answer: "changed" }] })
        ).rejects.toThrow("reserved");
        if (!prepared.promptReceipt) {
            throw new Error("missing prompt receipt");
        }

        await expect(
            sendDrafts({ session: "s", promptReceipt: { ...prepared.promptReceipt, text: "wrong" } }, deps)
        ).rejects.toThrow("pending answers changed");
        expect(readDecisions(deps.file).map((row) => row.state)).toEqual(["answered", "drafted"]);
        expect(readDecisions(deps.file)[0]?.promptReservation?.token).toBe(prepared.promptReceipt.token);
        await sendDrafts({ session: "s", promptReceipt: prepared.promptReceipt, releasePrompt: true }, deps);
        await updateDecisions(deps.file, deps.events, { updates: [{ id: first.id, answer: "changed" }] });
        const retry = await sendDrafts({ session: "s", inSession: true }, deps);
        const dry = await sendDrafts({ session: "s", promptReceipt: retry.promptReceipt, dryRun: true }, deps);
        expect(dry.dryRun).toBe(true);
        expect(readDecisions(deps.file).every((row) => row.state === "answered")).toBe(true);
    });

    test("a failed submission releases only its lease, and abandoned preparations expire", async () => {
        const deps = { ...scratch(), block: async () => null };
        await postDecisions(deps.file, deps.events, {
            sessionId: "s",
            decisions: [{ prompt: "One?", options: ["yes"] }],
        });
        await draftDecision({ session: "s", number: 1, option: "a" }, deps);
        const first = await sendDrafts({ session: "s", inSession: true }, deps);
        await sendDrafts({ session: "s", promptReceipt: first.promptReceipt, releasePrompt: true }, deps);
        expect(deliverDecisions(readDecisions(deps.file), () => undefined).numbers).toEqual([1]);
        await reservePromptDecisions({ ...deps, session: "s", now: Date.now() - 6 * 60_000 });
        expect(deliverDecisions(readDecisions(deps.file), () => undefined).numbers).toEqual([1]);
        const newer = await sendDrafts({ session: "s", inSession: true }, deps);
        await sendDrafts({ session: "s", promptReceipt: first.promptReceipt, releasePrompt: true }, deps);
        await expect(sendDrafts({ session: "s", promptReceipt: first.promptReceipt }, deps)).rejects.toThrow(
            "pending answers changed"
        );
        expect(readDecisions(deps.file)[0]?.promptReservation?.token).toBe(newer.promptReceipt?.token);
        await sendDrafts({ session: "s", promptReceipt: newer.promptReceipt }, deps);
        expect(readDecisions(deps.file)[0]?.promptReservation).toBeUndefined();
        expect(readDecisions(deps.file)[0]?.state).toBe("sent");
    });

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
            matchedOn: "title-id",
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
        expect(typed[0]).toEqual([
            "claude",
            "cmux",
            "send",
            "--json",
            "--paste",
            "--exact-session",
            "--",
            "s",
            "DECISION 1: a) a1\nDECISION 2: b) note",
        ]);
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
            matchedOn: "title-id",
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
        expect(typed).toEqual([
            ["claude", "cmux", "send", "--json", "--paste", "--exact-session", "--", "s", "DECISION 1: b) b1"],
        ]);
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

    test("the resume stamp keeps a queue reservation, while a row nobody reserved still gets the stamp", async () => {
        const { file, events } = scratch();
        const [reserved, open] = await postDecisions(file, events, {
            sessionId: "s",
            decisions: [
                { prompt: "One?", options: ["a1", "b1"] },
                { prompt: "Two?", options: ["a2", "b2"] },
            ],
        });
        const reservation = { route: "queued" as const, queueId: "queue-a", at: "2026-01-01T00:00:00.000Z" };
        writeFileSync(
            file,
            `${[
                { ...reserved, state: "answered", option: "a", delivery: reservation },
                { ...open, state: "answered", option: "a" },
            ]
                .map((row) => SafeJSON.stringify(row))
                .join("\n")}\n`
        );

        await sendDrafts(
            { session: "s", provider: "claude", recordResumeTarget: "cmux · new workspace" },
            {
                file,
                events,
                block: async () => null,
                deliver: {
                    runTool: async () => {
                        throw new Error("must not type on resume");
                    },
                },
            }
        );

        const [first, second] = readDecisions(file);
        expect(first.delivery).toEqual(reservation);
        expect(second).toMatchObject({
            state: "answered",
            delivery: { route: "resume", target: "cmux · new workspace" },
        });
        expect(deliverDecisions(readDecisions(file), () => undefined).numbers).toEqual([2]);
    });
});
