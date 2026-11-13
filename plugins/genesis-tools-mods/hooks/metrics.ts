// The mods' lines for `tools metrics`, appended to `<genesis-tools>/metrics/spool/mods-<day>.jsonl` by `spoolEvents`:
// the hook ledger's `agent-context / hook.injection` (one event per entry the hooks hand the model) and the resume
// guard's `agent-context / agent.resume` (one event per message to an idle agent). The metrics service drains the
// spool into its store, so a session needs no service, no SQLite and nothing from `src/`.
//
// No engine types here: `src/metrics` imports `injectionSource` for its import of the old `hooks.jsonl`. A producer
// passes its own queued appender (`appendJsonl` in `shared.ts`) in.
//
// `value` is the characters the hook produced for that part. A part the dedupe replaced by a receipt keeps its own
// length and `dropped: true`, so the sum over `dropped = false` is what reached the model, and the sum over
// `dropped = true` is what the dedupe saved. `model` is the model of the loop the injection went to, null while the
// plugin has not seen it; `delivery` says how an area rule came: `full` (its text) or `pointer` (one line naming it).

/** The spool line version `src/utils/metrics/spool.ts` reads. */
export const METRICS_SPOOL_VERSION = 1;

export const INJECTION_PROJECT = "agent-context";
export const INJECTION_METRIC = "hook.injection";

/**
 * The spool line that declares a metric, so the dims a question groups and filters by get their index. `spoolEvents`
 * writes it once per plugin load; declaring again changes nothing.
 */
export interface MetricDefinition {
    v: number;
    define: {
        project: string;
        metric: string;
        unit?: string;
        description?: string;
        dims?: readonly string[];
    };
}

export const INJECTION_DEFINITION = {
    v: METRICS_SPOOL_VERSION,
    define: {
        project: INJECTION_PROJECT,
        metric: INJECTION_METRIC,
        unit: "chars",
        description: "One additionalContext entry or block reason a hook handed the model",
        dims: ["session", "agent", "agentType", "event", "source", "rule", "dropped", "model", "delivery"],
    },
} as const satisfies MetricDefinition;

export const RESUME_METRIC = "agent.resume";

/** The resume guard's metric: `value` is the agent's context in tokens at its last call. */
export const RESUME_DEFINITION = {
    v: METRICS_SPOOL_VERSION,
    define: {
        project: INJECTION_PROJECT,
        metric: RESUME_METRIC,
        unit: "tokens",
        description: "One message to an agent of the session that was not running, and what the resume guard did",
        dims: ["session", "agent", "agentType", "kind", "idleSeconds", "outcome", "model", "name"],
    },
} as const satisfies MetricDefinition;

export const RESUME_RESULT_METRIC = "agent.resume.result";

/**
 * What a resume the guard let through cost: `value` is the cache-write tokens of the agent's next model response
 * (the context written again), and `cache` says how much of the context before the pause the cache still held.
 */
export const RESUME_RESULT_DEFINITION = {
    v: METRICS_SPOOL_VERSION,
    define: {
        project: INJECTION_PROJECT,
        metric: RESUME_RESULT_METRIC,
        unit: "tokens",
        description: "The cache-write tokens of an agent's first response after a message the resume guard let through",
        dims: ["session", "agent", "agentType", "kind", "model", "idleSeconds", "decision", "cache"],
    },
} as const satisfies MetricDefinition;

/** Where an entry of area-rule blocks splits: before each `Contents of <path> (area rules):`. */
export const AREA_BLOCK = /(?=Contents of \S+ \(area rules\):)/;

/**
 * One area rule handed as a pointer: `Area rules (pointer): <absolute path> (<n> lines): <scope>`. The genesis-tools
 * plugin's `area-rules.ts` (`pointerLine`) writes this exact shape; change both together.
 */
const POINTER_LINE = /^Area rules \(pointer\): (.+?) \(\d+ lines?\): .*$/;

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
    /** The model of that loop, or null while unknown. */
    model: string | null;
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
    /** The receipts the model got instead; absent (an old hook log) leaves them uncounted. */
    receipts?: InjectionReceipts;
}

/** The receipt text that replaced a whole entry, and each replaced area-rule block's by its path. */
export interface InjectionReceipts {
    whole?: string;
    rules?: Readonly<Record<string, string>>;
}

/** A spool line's object, before `JSON.stringify`. */
export interface SpoolEvent {
    v: number;
    project: string;
    metric: string;
    at: number;
    value: number;
    dims: Record<string, string | number | boolean | null>;
    /** Free JSON kept with the event: an injection's first characters, the resume guard's exact numbers. */
    context?: unknown;
}

/** An injection's event always carries the first characters of its text. */
export type InjectionEvent = SpoolEvent & { context: string };

/** How an area rule reached the model; null for every other kind of injection. */
type Delivery = "full" | "pointer" | null;

function eventOf(
    facts: InjectionFacts,
    part: {
        text: string;
        at: number;
        kind: string;
        rule: string | null;
        dropped: boolean;
        source?: string;
        delivery?: Delivery;
        /** The characters counted, when not the text's length. */
        value?: number;
    }
): InjectionEvent {
    return {
        v: METRICS_SPOOL_VERSION,
        project: INJECTION_PROJECT,
        metric: INJECTION_METRIC,
        at: part.at,
        value: part.value ?? part.text.length,
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
            model: facts.model,
            delivery: part.delivery ?? null,
        },
        context: part.text.slice(0, CONTEXT_CHARS),
    };
}

/**
 * A part the dedupe dropped: one `dropped` event worth the characters it saved (the part's length less its receipt's),
 * and one `receipt` event, not dropped, for the receipt the model got instead. So the events that are not dropped add
 * up to what the model was handed, and the dropped ones to what it was spared. Without a receipt (an old hook log)
 * the whole part counts as saved.
 */
function droppedEvents(
    facts: InjectionFacts,
    part: { text: string; receipt?: string; at: number; rule: string | null; source?: string; delivery: Delivery }
): InjectionEvent[] {
    const shared = {
        at: part.at,
        rule: part.rule,
        source: part.source ?? injectionSource(part.text),
        delivery: part.delivery,
    };
    const saved = eventOf(facts, {
        ...shared,
        text: part.text,
        kind: "context",
        dropped: true,
        value: part.text.length - (part.receipt?.length ?? 0),
    });

    if (!part.receipt) {
        return [saved];
    }

    return [saved, eventOf(facts, { ...shared, text: part.receipt, kind: "receipt", dropped: false })];
}

/** An entry's pointer lines, and its text without them. */
function pointersOf(text: string): { pointers: Array<{ line: string; rule: string }>; rest: string } {
    const pointers: Array<{ line: string; rule: string }> = [];
    const rest = text.split("\n").filter((line) => {
        const match = POINTER_LINE.exec(line);

        if (match?.[1]) {
            pointers.push({ line, rule: match[1] });
            return false;
        }

        return true;
    });

    return { pointers, rest: pointers.length ? rest.join("\n") : text };
}

/** How a whole entry's area rules came, for an entry the dedupe dropped whole. */
function deliveryOf(text: string): Delivery {
    if (AREA_BLOCK.test(text)) {
        return "full";
    }

    return text.split("\n").some((line) => POINTER_LINE.test(line)) ? "pointer" : null;
}

/**
 * The events of one hook answer: one per entry, an entry of area-rule blocks split into one per rule file (its
 * preface its own event), one per area-rule pointer line, and one for a `block` reason.
 */
export function injectionEvents(
    facts: InjectionFacts,
    answer: { entries: readonly InjectionEntry[]; block: string; at: number }
): InjectionEvent[] {
    const events: InjectionEvent[] = [];
    const { at } = answer;

    for (const entry of answer.entries) {
        if (entry.whole) {
            const delivery = deliveryOf(entry.text);
            events.push(
                ...droppedEvents(facts, {
                    text: entry.text,
                    receipt: entry.receipts?.whole,
                    at,
                    rule: null,
                    delivery,
                    ...(delivery ? { source: "area-rules" } : {}),
                })
            );
            continue;
        }

        const { pointers, rest } = pointersOf(entry.text);

        for (const pointer of pointers) {
            events.push(
                eventOf(facts, {
                    text: pointer.line,
                    at,
                    kind: "context",
                    rule: pointer.rule,
                    dropped: false,
                    source: "area-rules",
                    delivery: "pointer",
                })
            );
        }

        const [preface = "", ...blocks] = rest.split(AREA_BLOCK);

        if (blocks.length === 0) {
            if (pointers.length === 0 || preface.trim()) {
                events.push(
                    eventOf(facts, {
                        text: preface,
                        at,
                        kind: "context",
                        rule: null,
                        dropped: false,
                        ...(pointers.length ? { source: "area-rules", delivery: "pointer" as const } : {}),
                    })
                );
            }

            continue;
        }

        if (preface.trim()) {
            events.push(
                eventOf(facts, {
                    text: preface,
                    at,
                    kind: "context",
                    rule: null,
                    dropped: false,
                    source: "area-rules",
                    delivery: "full",
                })
            );
        }

        for (const block of blocks) {
            const rule = /^Contents of (\S+)/.exec(block)?.[1] ?? null;

            if (rule !== null && entry.droppedRules.includes(rule)) {
                events.push(
                    ...droppedEvents(facts, {
                        text: block,
                        receipt: entry.receipts?.rules?.[rule],
                        at,
                        rule,
                        source: "area-rules",
                        delivery: "full",
                    })
                );
                continue;
            }

            events.push(
                eventOf(facts, {
                    text: block,
                    at,
                    kind: "context",
                    rule,
                    dropped: false,
                    source: "area-rules",
                    delivery: "full",
                })
            );
        }
    }

    if (answer.block) {
        events.push(eventOf(facts, { text: answer.block, at, kind: "block", rule: null, dropped: false }));
    }

    return events;
}

/** A spool line that could not be written: the producer logs it, so a missing metric is found in its log. */
export interface SpoolFailure {
    path: string;
    line: "define" | "event";
    metric: string;
    error: unknown;
}

/**
 * Appends `events` to the day's spool file of `at`, one line each, after the metric's define line. Every batch carries
 * its define line: a define written once per plugin load and lost once left the metric undeclared until the next load.
 * The drain treats a repeated define as an upsert. A line that cannot be written is dropped and handed to `report`
 * (the producer's log); a producer never fails on the spool.
 */
export async function spoolEvents({
    append,
    report,
    home,
    definition,
    events,
    at,
}: {
    append: (path: string, record: Record<string, unknown>) => Promise<void>;
    report: (failure: SpoolFailure) => Promise<void> | void;
    home: string;
    definition: MetricDefinition;
    events: readonly SpoolEvent[];
    at: number;
}): Promise<void> {
    if (events.length === 0) {
        return;
    }

    const path = modsSpoolPath(home, at);
    const metric = `${definition.define.project}/${definition.define.metric}`;
    const write = async (line: SpoolFailure["line"], record: Record<string, unknown>) => {
        try {
            await append(path, record);
        } catch (error) {
            await Promise.resolve(report({ path, line, metric, error })).catch(() => undefined);
        }
    };

    await write("define", { ...definition });

    for (const event of events) {
        await write("event", { ...event });
    }
}
