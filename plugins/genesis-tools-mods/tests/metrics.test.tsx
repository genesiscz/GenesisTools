import { expect, test } from "claude-code/testing";
import { injectionEvents, injectionSource, modsSpoolPath } from "../hooks/metrics";

const facts = {
    session: "s-1",
    agent: "main",
    agentType: null,
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
        dims: { session: "s-1", agent: "main", event: "PostToolUse", tool: "Bash", harness: "claude", kind: "context" },
    });
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

test("metrics: sources by first line, a receipt names what it replaced, and the spool path", () => {
    expect(injectionSource("<persisted-output>\nOutput too large")).toBe("persisted-output");
    expect(injectionSource('[genesis-tools-mods: "INBOX: the user\'s widget" repeated, 900 characters')).toBe("inbox");
    expect(injectionSource("Something new")).toBe("other");
    expect(modsSpoolPath("/home/fixture", new Date(2026, 10, 11, 9, 30).getTime())).toBe(
        "/home/fixture/.genesis-tools/metrics/spool/mods-2026-11-11.jsonl"
    );
});
