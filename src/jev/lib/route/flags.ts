import { admittedChoice } from "@app/control/lib/decision/decisions";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { CatalogueRow, RouteFlag } from "./catalogue";

const { log } = logger.scoped("jev-route");
const prof = profiler.scope("jev-route");

/** Jev answers a boolean as a probability; 0.8 is the project-wide admission floor. */
const MIN_BOOLEAN_PROBABILITY = 0.8;
const MAX_SPANS = 24;
const MAX_FLAG_QUESTIONS = 24;
const MAX_VALUE_QUESTIONS = 8;

export interface UtteranceSpan {
    start: number;
    end: number;
    text: string;
}

export interface PositionalSlot {
    name: string;
    required: boolean;
    variadic: boolean;
}

export interface RouteBinding {
    kind: "flag" | "positional";
    /** Long flag name without dashes, or the positional's name from the usage line. */
    name: string;
    /** The argv token that carries the flag, e.g. `-u`. Absent for a positional. */
    token?: string;
    value?: string;
    span?: UtteranceSpan;
    probability: number;
    /** `jev` when a Jev answer chose it, `exact` when a single literal token filled a required slot. */
    source: "jev" | "exact";
}

export interface BindResult {
    bindings: RouteBinding[];
    /** Flags and slots that were asked about and left out, with the reason. */
    unbound: string[];
    requests: number;
}

const TOKEN_RE = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
const POSITIONAL_RE = /<([^>]+)>|\[([^\]]+)\]/g;
const NUMERIC_RE = /^\d{1,9}$/;

export function booleanProbability(result: EvaluationResponse, id: string): number | null {
    const answer = result.answers[id];
    return answer?.type === "boolean" ? answer.probability : null;
}

/**
 * Every literal span of the utterance a value may be bound to.
 *
 * Binding by span is what keeps invariant 6 ("no free typing") true for route: a flag value is
 * always a substring the human actually said, with its offsets recorded, never text a model
 * produced.
 */
export function utteranceSpans(utterance: string, limit = MAX_SPANS): UtteranceSpan[] {
    const spans: UtteranceSpan[] = [];
    const seen = new Set<string>();
    for (const match of utterance.matchAll(TOKEN_RE)) {
        const quoted = match[1] ?? match[2];
        const raw = quoted ?? match[3] ?? "";
        let start = (match.index ?? 0) + (quoted === undefined ? 0 : 1);
        let text = raw;
        if (quoted === undefined) {
            // Trim punctuation that frames a word, including a leading dash, so a flag the human
            // typed ("--repo") never becomes a candidate VALUE. Inner dots and dashes stay, so
            // "src/foo.ts" and "feat-branch" survive whole.
            const left = raw.replace(/^[^\w/@]+/, "");
            start += raw.length - left.length;
            text = left.replace(/[^\w/@]+$/, "");
        }

        if (!text || seen.has(text)) {
            continue;
        }

        seen.add(text);
        spans.push({ start, end: start + text.length, text });
        if (spans.length >= limit) {
            break;
        }
    }
    return spans;
}

/** Positional slots declared by a usage line such as `<pr>` or `[refs...]`. */
export function positionalSlots(argHint: string): PositionalSlot[] {
    const slots: PositionalSlot[] = [];
    for (const match of argHint.matchAll(POSITIONAL_RE)) {
        const required = match[1] !== undefined;
        const body = (match[1] ?? match[2] ?? "").trim();
        if (!body || body === "options" || body === "command") {
            continue;
        }

        const variadic = body.endsWith("...");
        slots.push({ name: body.replace(/\.\.\.$/, ""), required, variadic });
    }
    return slots;
}

/**
 * The argv token for a flag.
 *
 * The short form wins when the option declares one, because a routed command is printed for a
 * human to read and edit, and the consolidation spec pins `-u` for `github review`.
 */
export function flagToken(flag: RouteFlag): string {
    return flag.short ?? `--${flag.name}`;
}

function questionId(prefix: string, name: string): string {
    return `${prefix}_${name.replaceAll("-", "_")}`;
}

function askedFlags(row: CatalogueRow): RouteFlag[] {
    return row.flags.slice(0, MAX_FLAG_QUESTIONS);
}

function presenceQuestions(utterance: string, flags: RouteFlag[], slots: PositionalSlot[]) {
    const questions: Record<string, { type: "boolean"; instructions: string }> = {};
    for (const flag of flags) {
        questions[questionId("flag", flag.name)] = {
            type: "boolean",
            instructions: `The option --${flag.name} does this: ${flag.description || flag.name}. Does the utterance ask for that, either by naming the option or by describing its effect?`,
        };
    }
    for (const [index, slot] of slots.entries()) {
        questions[questionId("pos", `${index}_${slot.name}`)] = {
            type: "boolean",
            instructions: `Does the utterance state a value for the "${slot.name}" argument of this command?`,
        };
    }
    log.debug(
        { utteranceLength: utterance.length, flagCount: flags.length, slotCount: slots.length },
        "Built the Jev binding presence questions"
    );
    return questions;
}

function spanCriteria(spans: UtteranceSpan[]): Record<string, string> {
    const criteria: Record<string, string> = {};
    for (const span of spans) {
        criteria[span.text] = `characters ${span.start}-${span.end} of the utterance`;
    }
    criteria.none = "No span of the utterance is this value.";
    return criteria;
}

/**
 * Fill a required positional that Jev declined to bind, when the utterance contains exactly one
 * unused number. The value is still a literal span, so nothing is invented; it only rescues the
 * common `PR 409` shape where the number is unambiguous.
 */
function exactFallback(slot: PositionalSlot, spans: UtteranceSpan[], used: Set<string>): RouteBinding | null {
    if (!slot.required) {
        return null;
    }

    const numbers = spans.filter((span) => NUMERIC_RE.test(span.text) && !used.has(span.text));
    if (numbers.length !== 1) {
        return null;
    }

    log.debug({ slot: slot.name, value: numbers[0].text }, "Bound a required positional from the only literal number");
    return {
        kind: "positional",
        name: slot.name,
        value: numbers[0].text,
        span: numbers[0],
        probability: 1,
        source: "exact",
    };
}

function valueQuestions(options: { flags: RouteFlag[]; slots: PositionalSlot[]; spans: UtteranceSpan[] }) {
    const criteria = spanCriteria(options.spans);
    const entries: Array<[string, { type: "choice"; instructions: string; criteria: Record<string, string> }]> = [];
    for (const flag of options.flags) {
        entries.push([
            questionId("value", flag.name),
            {
                type: "choice",
                instructions: `Which span of the utterance is the value of --${flag.name} (${flag.description || "no description"})?`,
                criteria,
            },
        ]);
    }
    for (const [index, slot] of options.slots.entries()) {
        entries.push([
            questionId("slot", `${index}_${slot.name}`),
            {
                type: "choice",
                instructions: `Which span of the utterance is the "${slot.name}" argument of this command?`,
                criteria,
            },
        ]);
    }
    return Object.fromEntries(entries);
}

/** Second Jev request: pick the utterance span that carries each value. */
async function bindValues(options: {
    utterance: string;
    row: CatalogueRow;
    evaluate: Evaluator;
    signal?: AbortSignal;
    flags: RouteFlag[];
    slots: PositionalSlot[];
    spans: UtteranceSpan[];
}): Promise<{ bindings: RouteBinding[]; unbound: string[] }> {
    const values = await prof.measureAsync("bind", () =>
        options.evaluate({
            signal: options.signal,
            input: {
                state: { utterance: options.utterance, command: options.row.path },
                questions: valueQuestions(options),
            },
        })
    );
    const allowed = [...options.spans.map((span) => span.text), "none"];
    const bindings: RouteBinding[] = [];
    const unbound: string[] = [];
    for (const flag of options.flags) {
        const choice = admittedChoice({ result: values, id: questionId("value", flag.name), allowed });
        const span = options.spans.find((item) => item.text === choice.choice);
        if (!choice.admitted || !span) {
            unbound.push(`--${flag.name}: ${choice.choice === "none" ? "no-span" : choice.reason}`);
            continue;
        }

        bindings.push({
            kind: "flag",
            name: flag.name,
            token: flagToken(flag),
            value: span.text,
            span,
            probability: choice.probability,
            source: "jev",
        });
    }
    for (const [index, slot] of options.slots.entries()) {
        const choice = admittedChoice({ result: values, id: questionId("slot", `${index}_${slot.name}`), allowed });
        const span = options.spans.find((item) => item.text === choice.choice);
        if (!choice.admitted || !span) {
            unbound.push(`${slot.name}: ${choice.choice === "none" ? "no-span" : choice.reason}`);
            continue;
        }

        bindings.push({
            kind: "positional",
            name: slot.name,
            value: span.text,
            span,
            probability: choice.probability,
            source: "jev",
        });
    }
    return { bindings, unbound };
}

/**
 * Bind flags and positionals of the chosen row to spans of the utterance.
 *
 * Two Jev requests at most: one asks whether each flag or slot is stated at all, the second
 * picks the span that carries each value. Nothing is bound below the 0.8 admission floor.
 */
export async function bindArgv(options: {
    utterance: string;
    row: CatalogueRow;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<BindResult> {
    const flags = askedFlags(options.row);
    const slots = positionalSlots(options.row.argHint);
    const spans = utteranceSpans(options.utterance);
    if (!flags.length && !slots.length) {
        log.debug({ path: options.row.path }, "Chosen row declares no flags or positionals; nothing to bind");
        return { bindings: [], unbound: [], requests: 0 };
    }

    const presence = await prof.measureAsync("bind", () =>
        options.evaluate({
            signal: options.signal,
            input: {
                state: { utterance: options.utterance, command: options.row.path, argHint: options.row.argHint },
                questions: presenceQuestions(options.utterance, flags, slots),
            },
        })
    );
    const wantedFlags = flags.filter(
        (flag) => (booleanProbability(presence, questionId("flag", flag.name)) ?? 0) >= MIN_BOOLEAN_PROBABILITY
    );
    const wantedSlots = slots.filter(
        (slot, index) =>
            (booleanProbability(presence, questionId("pos", `${index}_${slot.name}`)) ?? 0) >= MIN_BOOLEAN_PROBABILITY
    );
    log.info(
        {
            path: options.row.path,
            flagsAsked: flags.length,
            flagsWanted: wantedFlags.map((flag) => flag.name),
            slotsWanted: wantedSlots.map((slot) => slot.name),
            probabilities: Object.fromEntries(
                flags.map((flag) => [flag.name, booleanProbability(presence, questionId("flag", flag.name)) ?? 0])
            ),
        },
        "Jev answered the binding presence questions"
    );

    const bindings: RouteBinding[] = wantedFlags
        .filter((flag) => !flag.takesValue)
        .map((flag) => ({
            kind: "flag" as const,
            name: flag.name,
            token: flagToken(flag),
            probability: booleanProbability(presence, questionId("flag", flag.name)) ?? 0,
            source: "jev" as const,
        }));
    const unbound: string[] = [];
    const valueFlags = wantedFlags.filter((flag) => flag.takesValue).slice(0, MAX_VALUE_QUESTIONS);
    const valueSlots = wantedSlots.slice(0, Math.max(0, MAX_VALUE_QUESTIONS - valueFlags.length));
    let requests = 1;
    if (valueFlags.length || valueSlots.length) {
        requests += 1;
        const bound = await bindValues({ ...options, flags: valueFlags, slots: valueSlots, spans });
        bindings.push(...bound.bindings);
        unbound.push(...bound.unbound);
    }

    const used = new Set(bindings.map((binding) => binding.value).filter((value): value is string => Boolean(value)));
    for (const slot of slots) {
        if (bindings.some((binding) => binding.kind === "positional" && binding.name === slot.name)) {
            continue;
        }

        const fallback = exactFallback(slot, spans, used);
        if (fallback?.value) {
            bindings.push(fallback);
            used.add(fallback.value);
            continue;
        }

        if (slot.required) {
            unbound.push(`${slot.name}: unbound-required`);
        }
    }

    log.info(
        { path: options.row.path, bound: bindings.length, unbound, requests },
        "Jev binding finished for the chosen row"
    );
    return { bindings, unbound, requests };
}

/**
 * Assemble argv from a base path and the bindings: positionals first in declaration order, then
 * flags. A flag that takes a value is only emitted when a span filled it.
 */
export function applyBindings(base: string[], bindings: RouteBinding[]): string[] {
    const argv = [...base];
    for (const binding of bindings) {
        if (binding.kind === "positional" && binding.value) {
            argv.push(binding.value);
        }
    }
    for (const binding of bindings) {
        if (binding.kind !== "flag" || !binding.token) {
            continue;
        }

        argv.push(binding.token);
        if (binding.value !== undefined) {
            argv.push(binding.value);
        }
    }
    return argv;
}
