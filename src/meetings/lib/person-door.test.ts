import { expect, mock, test } from "bun:test";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import type { DecisionActor, MeetingItem } from "@genesiscz/utils/meetings/record";
import { requestMeetingQuestionReview } from "./person-door";

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
