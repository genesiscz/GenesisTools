// The hook ledger's lines for `tools metrics`: one `agent-context / hook.injection` event per entry the hooks hand
// the model, appended to `<genesis-tools>/metrics/spool/mods-<day>.jsonl`. The metrics service drains the spool into
// its store, so a session needs no service, no SQLite and nothing from `src/`.
//
// No engine types here: `src/metrics` imports `injectionSource` for its import of the old `hooks.jsonl`. The ledger
// passes its own queued appender (`appendJsonl` in `shared.ts`) in.
//
// `value` is the characters the hook produced for that part. A part the dedupe replaced by a receipt keeps its own
// length and `dropped: true`, so the sum over `dropped = false` is what reached the model, and the sum over
// `dropped = true` is what the dedupe saved.

/** The spool line version `src/utils/metrics/spool.ts` reads. */
export const METRICS_SPOOL_VERSION = 1;

export const INJECTION_PROJECT = "agent-context";
export const INJECTION_METRIC = "hook.injection";

/**
 * The spool line that declares the metric, so the dims a question groups and filters by get their index. The ledger
 * writes it once per plugin load; declaring again changes nothing.
 */
export const INJECTION_DEFINITION = {
    v: METRICS_SPOOL_VERSION,
    define: {
        project: INJECTION_PROJECT,
        metric: INJECTION_METRIC,
        unit: "chars",
        description: "One additionalContext entry or block reason a hook handed the model",
        dims: ["session", "agent", "agentType", "event", "source", "rule", "dropped"],
    },
} as const;

/** Where an entry of area-rule blocks splits: before each `Contents of <path> (area rules):`. */
export const AREA_BLOCK = /(?=Contents of \S+ \(area rules\):)/;

const RECEIPT = /^\[genesis-tools-mods: "(.*)/;
const CONTEXT_CHARS = 100;

/** A short name for each kind of injection, by its first line. The first match wins. */
const SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
    [/area rules/, "area-rules"],
    [/^The following rules are in force/, "weak-model-inject"],
    [/^<persisted-output>/, "persisted-output"],
    [/^Invoke the `genesis-tools:agents-talk`/, "agents-talk"],
    [/^INBOX:/, "inbox"],
    [/^⚠️ Shell hygiene/, "shell-hygiene"],
    [/^ℹ️ this repo is bound to vitrinka|^⚠️ \.mcp\.json carries/, "vitrinka"],
    [/^📌 Session ID:/, "session-id"],
    [/^rm request /, "rm-request"],
    [/^\[session-name\]/, "session-name"],
    [/^The memory index at MEMORY\.md/, "memory-index"],
    [/^\[graft\]/, "graft"],
    [/^Unified-branch check/, "unified-branch-check"],
    [/^Your reply asks|^The user's messages since these decisions/, "decision-nudge"],
    [/^\[bun /, "hook-command"],
];

/** The short name of an injection (`area-rules`, `shell-hygiene`, ...), or `other`; a receipt names what it replaced. */
export function injectionSource(text: string): string {
    const first = text.split("\n", 1)[0] ?? "";
    const receipt = RECEIPT.exec(first);
    const head = receipt ? (receipt[1] ?? "") : first;

    if (AREA_BLOCK.test(text) && !receipt) {
        return "area-rules";
    }

    return SOURCES.find(([pattern]) => pattern.test(head))?.[1] ?? "other";
}

/** `<home>/.genesis-tools/metrics/spool/mods-<local day>.jsonl`. */
export function modsSpoolPath(home: string, now = Date.now()): string {
    const date = new Date(now);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

    return `${home}/.genesis-tools/metrics/spool/mods-${day}.jsonl`;
}

/** Who and what one hook answer was for. */
export interface InjectionFacts {
    session: string;
    /** `main`, or the subagent's id. */
    agent: string;
    agentType: string | null;
    event: string;
    tool: string | null;
    harness: string;
}

/** One `additionalContext` entry as the hook produced it, and what the dedupe did to it. */
export interface InjectionEntry {
    text: string;
    /** The dedupe replaced the whole entry by a receipt. */
    whole: boolean;
    /** The area-rule files whose blocks the dedupe replaced by a receipt. */
    droppedRules: readonly string[];
}

/** A spool line's object, before `JSON.stringify`. */
export interface SpoolEvent {
    v: number;
    project: string;
    metric: string;
    at: number;
    value: number;
    dims: Record<string, string | number | boolean | null>;
    context: string;
}

function eventOf(
    facts: InjectionFacts,
    part: { text: string; at: number; kind: string; rule: string | null; dropped: boolean; source?: string }
): SpoolEvent {
    return {
        v: METRICS_SPOOL_VERSION,
        project: INJECTION_PROJECT,
        metric: INJECTION_METRIC,
        at: part.at,
        value: part.text.length,
        dims: {
            session: facts.session,
            agent: facts.agent,
            agentType: facts.agentType,
            event: facts.event,
            tool: facts.tool,
            source: part.source ?? injectionSource(part.text),
            rule: part.rule,
            kind: part.kind,
            harness: facts.harness,
            dropped: part.dropped,
        },
        context: part.text.slice(0, CONTEXT_CHARS),
    };
}

/**
 * The events of one hook answer: one per entry, an entry of area-rule blocks split into one per rule file (its
 * preface its own event), and one for a `block` reason.
 */
export function injectionEvents(
    facts: InjectionFacts,
    answer: { entries: readonly InjectionEntry[]; block: string; at: number }
): SpoolEvent[] {
    const events: SpoolEvent[] = [];
    const { at } = answer;

    for (const entry of answer.entries) {
        if (entry.whole) {
            events.push(eventOf(facts, { text: entry.text, at, kind: "context", rule: null, dropped: true }));
            continue;
        }

        const [preface = "", ...blocks] = entry.text.split(AREA_BLOCK);

        if (blocks.length === 0) {
            events.push(eventOf(facts, { text: entry.text, at, kind: "context", rule: null, dropped: false }));
            continue;
        }

        if (preface.trim()) {
            events.push(
                eventOf(facts, { text: preface, at, kind: "context", rule: null, dropped: false, source: "area-rules" })
            );
        }

        for (const block of blocks) {
            const rule = /^Contents of (\S+)/.exec(block)?.[1] ?? null;
            events.push(
                eventOf(facts, {
                    text: block,
                    at,
                    kind: "context",
                    rule,
                    dropped: rule !== null && entry.droppedRules.includes(rule),
                    source: "area-rules",
                })
            );
        }
    }

    if (answer.block) {
        events.push(eventOf(facts, { text: answer.block, at, kind: "block", rule: null, dropped: false }));
    }

    return events;
}

/** Appends each event as one spool line through the ledger's appender; a line that cannot be written is dropped. */
export async function spoolInjections(
    append: (path: string, record: Record<string, unknown>) => Promise<void>,
    path: string,
    events: readonly SpoolEvent[]
): Promise<void> {
    for (const event of events) {
        await append(path, { ...event }).catch(() => undefined);
    }
}
