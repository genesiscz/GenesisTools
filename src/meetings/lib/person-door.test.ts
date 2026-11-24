import { describe, expect, mock, test } from "bun:test";
import { AGENT_STOP_LINE } from "@genesiscz/utils/ai/agent-instructions";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import type { RequestOutcome } from "@genesiscz/utils/genesis-tools/areas/person/request";
import type { DecisionActor, MeetingItem } from "@genesiscz/utils/meetings/record";
import {
    confirmVoiceSample,
    requestMeetingQuestionReview,
    type VoiceSampleAsk,
    voiceSampleRequestId,
} from "./person-door";

const agent: DecisionActor = { kind: "agent", harness: "fixture", session: "session-1" };
const record = { id: "2026-01-12_10-00-planning", title: "Planning" };
const word: Extract<MeetingItem, { kind: "question" }> = {
    id: "i1",
    kind: "question",
    about: "term",
    group: "words",
    status: "suggested",
    suggestedAt: "2026-01-12T11:00:00Z",
    fromSec: 4,
    toSec: 6,
    question: "Which spelling belongs here?",
    choices: [],
    decides: [],
    rules: [],
};
const dictionary = { ...word, id: "i2", about: "dictionary" as const };

function fakeGt() {
    type Notice = AreaClients["person"]["windowNotice"];
    const windowNotice = mock(
        async (args: Parameters<Notice>[0]): ReturnType<Notice> => ({
            status: "ran",
            via: "native",
            skipped: [],
            value: { id: args.id, status: "pending", reason: null },
        })
    );
    return { person: { windowNotice } };
}

test("one request names the Items tab of the meeting with pending word and dictionary questions", async () => {
    const gt = fakeGt();
    const warning = await requestMeetingQuestionReview({
        actor: agent,
        runId: "run-1",
        record: { ...record, items: [word, dictionary] },
        gt,
    });

    expect(warning).toBeUndefined();
    expect(gt.person.windowNotice).toHaveBeenCalledTimes(1);
    expect(gt.person.windowNotice.mock.calls[0]?.[0].reason).toContain(
        "tools meetings window 2026-01-12_10-00-planning --tab items"
    );
    expect(gt.person.windowNotice.mock.calls[0]?.[0].open).toEqual({
        window: "--meetings",
        args: ["--meeting", "2026-01-12_10-00-planning", "--tab", "items"],
    });
});

test("a dictionary question alone reaches the owner; settled and unrelated items do not", async () => {
    const gt = fakeGt();
    const run = { actor: agent, runId: "run-1", gt };
    await requestMeetingQuestionReview({ ...run, record: { ...record, items: [] } });
    await requestMeetingQuestionReview({
        ...run,
        record: {
            ...record,
            items: [
                { ...word, status: "confirmed" },
                { ...dictionary, status: "rejected" },
                { ...word, about: "speaker", group: "rules" },
                { ...word, group: undefined },
            ],
        },
    });
    await requestMeetingQuestionReview({ ...run, actor: { kind: "window" }, record: { ...record, items: [word] } });
    expect(gt.person.windowNotice).not.toHaveBeenCalled();

    await requestMeetingQuestionReview({ ...run, record: { ...record, items: [dictionary] } });
    expect(gt.person.windowNotice).toHaveBeenCalledTimes(1);
});

test("retries keep the journal key even when questions change; another run or meeting gets its own key", async () => {
    const gt = fakeGt();
    const first = { actor: agent, runId: "run/1", record: { ...record, items: [word] }, gt };
    await requestMeetingQuestionReview(first);
    await requestMeetingQuestionReview({ ...first, record: { ...record, items: [dictionary] } });
    await requestMeetingQuestionReview({ ...first, runId: "run:2" });
    await requestMeetingQuestionReview({ ...first, record: { ...first.record, id: "2026-01-13_10-00-planning" } });

    const ids = gt.person.windowNotice.mock.calls.map(([request]) => request.id);
    expect(ids).toHaveLength(4);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
});

test("delivery failures become warnings after the meeting has been saved", async () => {
    const gt = fakeGt();
    const run = { actor: agent, runId: "run-1", record: { ...record, items: [word] }, gt };
    gt.person.windowNotice.mockResolvedValueOnce({
        status: "ran",
        via: "native",
        skipped: [],
        value: { id: "fixture", status: "unreachable", reason: "Open the request manually." },
    });
    expect(await requestMeetingQuestionReview(run)).toBe("Open the request manually.");

    gt.person.windowNotice.mockRejectedValueOnce(new Error("journal unavailable"));
    expect(await requestMeetingQuestionReview(run)).toContain("journal unavailable");
});

test("a sandbox home never sends the real person a review request", async () => {
    // The test preload points GENESIS_TOOLS_HOME at a sandbox, as a probe or a measure run does.
    const warning = await requestMeetingQuestionReview({
        actor: agent,
        runId: "run-sandbox",
        record: { ...record, items: [word] },
    });
    expect(warning).toContain("no review request was sent");
});

describe("an agent's voice sample asks the user to confirm it (D443)", () => {
    type Confirm = AreaClients["person"]["confirm"];
    const sample: VoiceSampleAsk = {
        record,
        fromSec: 2595,
        toSec: 2605,
        person: "Alice Example",
        rerun: "tools meetings voices add 2026-01-12_10-00-planning --from 43:15 --to 43:25 --person 'Alice Example' --confirmed",
    };
    const ask = mock(() => sample);

    function door(answer: Omit<RequestOutcome, "id"> | "unreachable") {
        const confirm = mock(
            async (args: Parameters<Confirm>[0]): ReturnType<Confirm> =>
                answer === "unreachable"
                    ? {
                          status: "unreachable",
                          skipped: [
                              { way: "native", code: "no-display", reason: "no display to show it on", fix: null },
                          ],
                          manual: null,
                      }
                    : { status: "ran", via: "native", skipped: [], value: { ...answer, id: args.id } }
        );
        return { person: { confirm } };
    }

    test("a person's --confirmed is the confirmation, asks nobody and looks nothing up; without it the run refuses", async () => {
        ask.mockClear();
        const gt = door({ status: "done", reason: null });

        expect(await confirmVoiceSample({ actor: { kind: "cli" }, confirmed: true, ask, gt })).toEqual({
            confirmed: true,
            by: { kind: "caller", actor: "cli" },
        });
        await expect(confirmVoiceSample({ actor: { kind: "cli" }, confirmed: false, ask, gt })).rejects.toThrow(
            "--confirmed"
        );
        expect(gt.person.confirm).not.toHaveBeenCalled();
        expect(ask).not.toHaveBeenCalled();
    });

    test("an agent without --confirmed is told to stop and ask the user to listen; no window opens", async () => {
        const gt = door({ status: "done", reason: null });
        const result = await confirmVoiceSample({ actor: agent, confirmed: false, ask, gt });

        expect(gt.person.confirm).not.toHaveBeenCalled();
        expect(result.confirmed).toBe(false);
        const instructions = result.confirmed ? null : result.instructions;
        expect(instructions).toMatchObject({ severity: "info", stop: true });
        expect(instructions?.text).toContain("tools meetings play 2026-01-12_10-00-planning --at 43:15 --to 43:25");
        expect(instructions?.text).toContain(sample.rerun);
    });

    test("the user's confirmation in the window saves, named by its request and how the user answered", async () => {
        const gt = door({ status: "done", reason: null, via: "app-window", method: "click" });
        const result = await confirmVoiceSample({ actor: agent, confirmed: true, ask, gt });
        const id = voiceSampleRequestId(sample);

        expect(result).toEqual({
            confirmed: true,
            by: { kind: "request", request: id, via: "app-window", method: "click" },
            record,
        });
        const posted = gt.person.confirm.mock.calls[0]?.[0];
        expect(posted).toMatchObject({ kind: "notice", id, title: "Confirm a voice sample of Alice Example" });
        for (const context of [
            "An agent (fixture, session session-1)",
            "Meeting: Planning (2026-01-12_10-00-planning)",
            "Time: 43:15 to 43:25",
            "Person: Alice Example",
            "Listen first: tools meetings play 2026-01-12_10-00-planning --at 43:15 --to 43:25",
        ]) {
            expect(posted?.reason).toContain(context);
        }
        // The same interval asks the same request again, so a run after the answer reads it; another person does not.
        expect(voiceSampleRequestId({ ...sample })).toBe(id);
        expect(voiceSampleRequestId({ ...sample, person: "Bob Example" })).not.toBe(id);
        expect(voiceSampleRequestId({ ...sample, channel: 1 })).not.toBe(id);
    });

    test("a window still open, Not now, a failed request or no window at all stop the agent and save nothing", async () => {
        const cases = [
            [{ status: "pending", reason: null }, "info", "A confirmation window asks the user now"],
            [{ status: "declined", reason: null }, "error", "Not now"],
            [{ status: "failed", reason: "the app crashed" }, "error", "ended failed: the app crashed"],
            ["unreachable", "error", "No confirmation window could reach the user (no display to show it on)"],
        ] as const;

        for (const [answer, severity, says] of cases) {
            const result = await confirmVoiceSample({ actor: agent, confirmed: true, ask, gt: door(answer) });

            expect(result.confirmed).toBe(false);
            const instructions = result.confirmed ? null : result.instructions;
            expect(instructions).toMatchObject({ severity, stop: true });
            expect(instructions?.text).toContain(says);
            expect(instructions?.text).toContain("Nothing was saved");
            expect(instructions?.text).not.toContain(AGENT_STOP_LINE);
        }
    });

    test("a confirmation that cannot be posted stops the agent with the reason", async () => {
        const gt = door({ status: "done", reason: null });
        gt.person.confirm.mockRejectedValueOnce(new Error("journal unavailable"));
        const result = await confirmVoiceSample({ actor: agent, confirmed: true, ask, gt });

        expect(result.confirmed ? null : result.instructions.text).toContain("journal unavailable");
    });

    test("a sandbox home never opens the real person's window, and an invalid interval asks nobody", async () => {
        // The test preload points GENESIS_TOOLS_HOME at a sandbox, as a probe or a measure run does.
        const result = await confirmVoiceSample({ actor: agent, confirmed: true, ask });
        expect(result.confirmed ? null : result.instructions.text).toContain("sandbox home");

        const gt = door({ status: "done", reason: null });
        await expect(
            confirmVoiceSample({ actor: agent, confirmed: true, ask: () => ({ ...sample, toSec: Number.NaN }), gt })
        ).rejects.toThrow("valid --from/--to");
        expect(gt.person.confirm).not.toHaveBeenCalled();
    });
});
