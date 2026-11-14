import { expect, test } from "claude-code/testing";
import { dedupeEntry } from "../hooks/hook-ledger";
import {
    INJECTION_DEFINITION,
    type InjectionEvent,
    injectionEvents,
    injectionSource,
    modsSpoolPath,
    type SpoolFailure,
    spoolEvents,
} from "../hooks/metrics";

const facts = {
    session: "s-1",
    agent: "main",
    agentType: null,
    model: "fixture-model",
    event: "PostToolUse",
    tool: "Bash",
    harness: "claude",
};
const area = (path: string) => `Contents of ${path} (area rules):\n\n${"rule text ".repeat(20)}`;

test("metrics: an area-rules entry is one event per rule file, a dropped rule keeps its length", () => {
    const preface = "The Bash call touched files whose area rules were not in your context yet.\n\n";
    const text = `${preface}${area("/r/a.md")}\n\n${area("/r/b.md")}`;
    const events = injectionEvents(facts, {
        entries: [{ text, whole: false, droppedRules: ["/r/b.md"] }],
        block: "",
        at: 1_000,
    });

    expect(events.map((event) => [event.dims.rule, event.dims.dropped, event.dims.source])).toEqual([
        [null, false, "area-rules"],
        ["/r/a.md", false, "area-rules"],
        ["/r/b.md", true, "area-rules"],
    ]);
    expect(events.reduce((sum, event) => sum + event.value, 0)).toBe(text.length);
    expect(events[1]).toMatchObject({
        v: 1,
        project: "agent-context",
        metric: "hook.injection",
        at: 1_000,
        dims: {
            session: "s-1",
            agent: "main",
            event: "PostToolUse",
            tool: "Bash",
            harness: "claude",
            kind: "context",
            model: "fixture-model",
            delivery: "full",
        },
    });
    expect(events[0]?.dims.delivery).toBe("full");
    expect(events[1]?.context.length).toBe(100);
});

test("metrics: a whole repeat is one dropped event, a block reason its own event", () => {
    const events = injectionEvents(facts, {
        entries: [{ text: "⚠️ Shell hygiene (the command ran as written): ...", whole: true, droppedRules: [] }],
        block: "Your reply asks ❓ DECISION 1 without posting it.",
        at: 2_000,
    });

    expect(events.map((event) => [event.dims.source, event.dims.kind, event.dims.dropped])).toEqual([
        ["shell-hygiene", "context", true],
        ["decision-nudge", "block", false],
    ]);
});

test("metrics: a dropped part counts its receipt as handed and only the rest as saved, as the dedupe computed it", () => {
    const sum = (events: InjectionEvent[], dropped: boolean) =>
        events.filter((event) => event.dims.dropped === dropped).reduce((total, event) => total + event.value, 0);
    const held = new Map<string, number>();
    const hygiene = `⚠️ Shell hygiene (the command ran as written): ${"note ".repeat(80)}`;
    const preface = "The Bash call touched files whose area rules were not in your context yet.\n\n";
    const rules = `${preface}${area("/r/a.md")}\n\n${area("/r/b.md")}`;
    dedupeEntry(hygiene, held, 1_000);
    dedupeEntry(`${preface}${area("/r/b.md")}`, held, 1_000);

    // A whole repeat: the receipt is what the model got, the rest what it was spared.
    const whole = dedupeEntry(hygiene, held, 2_000);
    const wholeEvents = injectionEvents(facts, {
        entries: [{ text: hygiene, whole: true, droppedRules: [], receipts: whole.receipts }],
        block: "",
        at: 2_000,
    });
    expect(wholeEvents.map((event) => [event.dims.kind, event.dims.dropped, event.dims.source])).toEqual([
        ["context", true, "shell-hygiene"],
        ["receipt", false, "shell-hygiene"],
    ]);
    expect(sum(wholeEvents, false)).toBe(whole.text.length);
    expect(sum(wholeEvents, true)).toBe(whole.droppedChars);

    // One rule block repeated inside a new entry: its receipt is handed, its saving is the dedupe's own number.
    const blocks = dedupeEntry(rules, held, 3_000);
    expect(blocks.dropped).toEqual(["/r/b.md"]);
    const blockEvents = injectionEvents(facts, {
        entries: [{ text: rules, whole: false, droppedRules: blocks.dropped, receipts: blocks.receipts }],
        block: "",
        at: 3_000,
    });
    expect(blockEvents.map((event) => [event.dims.rule, event.dims.kind, event.dims.dropped])).toEqual([
        [null, "context", false],
        ["/r/a.md", "context", false],
        ["/r/b.md", "context", true],
        ["/r/b.md", "receipt", false],
    ]);
    expect(sum(blockEvents, true)).toBe(blocks.droppedChars);
    expect(sum(blockEvents, false) + sum(blockEvents, true)).toBe(rules.length);
});

/** A spool `append` whose first `times` writes fail with "disk full"; `lines` holds the records written after. */
function failingAppend(times: number) {
    const lines: Record<string, unknown>[] = [];
    let fails = times;
    const append = async (_path: string, record: Record<string, unknown>) => {
        if (fails > 0) {
            fails--;
            throw new Error("disk full");
        }

        lines.push(record);
    };

    return { append, lines };
}

/** One injection batch of a single new entry, as the spool tests write it. */
function newEvents() {
    return injectionEvents(facts, {
        entries: [{ text: "Something new", whole: false, droppedRules: [] }],
        block: "",
        at: 4_000,
    });
}

test("metrics: every batch carries its define line, so one lost write does not leave the metric undeclared", async () => {
    const { append, lines } = failingAppend(1);
    const failures: SpoolFailure[] = [];
    const report = (failure: SpoolFailure) => {
        failures.push(failure);
    };
    const events = newEvents();
    await spoolEvents({ append, report, home: "/home/fixture", definition: INJECTION_DEFINITION, events, at: 4_000 });
    await spoolEvents({ append, report, home: "/home/fixture", definition: INJECTION_DEFINITION, events, at: 5_000 });
    expect(lines.map((line) => ("define" in line ? "define" : "event"))).toEqual(["event", "define", "event"]);
    // The lost line is not silent: the producer's log gets it.
    expect(failures).toMatchObject([
        { line: "define", path: modsSpoolPath("/home/fixture", 4_000), error: new Error("disk full") },
    ]);
});

test("metrics: a report that throws synchronously does not stop the batch", async () => {
    const { append, lines } = failingAppend(1);
    const report = () => {
        throw new Error("log closed");
    };
    const events = newEvents();
    await spoolEvents({ append, report, home: "/home/fixture", definition: INJECTION_DEFINITION, events, at: 4_000 });
    expect(lines.map((line) => ("define" in line ? "define" : "event"))).toEqual(["event"]);
});

test("metrics: sources by first line, a receipt names what it replaced, and the spool path", () => {
    expect(injectionSource("<persisted-output>\nOutput too large")).toBe("persisted-output");
    expect(injectionSource('[genesis-tools-mods: "INBOX: the user\'s widget" repeated, 900 characters')).toBe("inbox");
    expect(injectionSource("Something new")).toBe("other");
    expect(modsSpoolPath("/home/fixture", new Date(2026, 10, 11, 9, 30).getTime())).toBe(
        "/home/fixture/.genesis-tools/metrics/spool/mods-2026-11-11.jsonl"
    );
});

test("metrics: a pointer line is one area-rules event with its path and length; other sources have no delivery", () => {
    const pointer = "Area rules (pointer): /r/.claude/rules/ai.md (8 lines): files under src/utils/ai/";
    const text = `The Bash call touched files whose area rules were not in your context yet. Follow them:\n${pointer}\n${area("/r/b.md")}`;
    const events = injectionEvents(
        { ...facts, model: null },
        {
            entries: [
                { text, whole: false, droppedRules: [] },
                { text: "⚠️ Shell hygiene (the command ran as written): ...", whole: false, droppedRules: [] },
                { text: `Preface\n${pointer}`, whole: true, droppedRules: [] },
            ],
            block: "",
            at: 3_000,
        }
    );

    expect(
        events.map((event) => [event.dims.source, event.dims.rule, event.dims.delivery, event.dims.dropped])
    ).toEqual([
        ["area-rules", "/r/.claude/rules/ai.md", "pointer", false],
        ["area-rules", null, "full", false],
        ["area-rules", "/r/b.md", "full", false],
        ["shell-hygiene", null, null, false],
        ["area-rules", null, "pointer", true],
    ]);
    expect(events[0]?.value).toBe(pointer.length);
    expect(events.every((event) => event.dims.model === null)).toBe(true);
});
