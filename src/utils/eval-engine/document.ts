// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/document.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * What a scenario and a matrix are: the check algebra, expectations, steps, their JSON form, validation against a
 * system's vocabulary, the typed builder, the canonical JSON and the hash, signal paths, bindings and templates.
 *
 * A scenario is a value. The TypeScript builder only writes the document; nothing here runs during a conversation.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvalSystem, Json, JsonObject } from "./system";

// ── The check algebra ────────────────────────────────────────────────────────

/**
 * - "safety": one failure in any repeat fails the cell whatever its pass rate; the run exits with 3. Code checks only.
 * - "gate": a failure fails the conversation; the cell passes when its pass rate reaches its threshold.
 * - "advisory": recorded and counted, never changes an outcome.
 */
export type Severity = "safety" | "gate" | "advisory";
const Severities = ["safety", "gate", "advisory"] as const satisfies readonly Severity[];

export interface Range {
    min?: number;
    max?: number;
}

/**
 * How one value is matched. Exactly one matcher per object (`min` and `max` together count as one).
 * A string inside `is`, `oneOf`, `matches` or `instant` may hold `{{name.path}}`, filled from the bindings.
 */
export type ValueMatch =
    | { is: Json }
    | { oneOf: Json[] }
    | { matches: string; flags?: string }
    | { min: number; max?: number }
    | { min?: number; max: number }
    | { size: Range }
    | { instant: string }
    | { exists: boolean };

/** A partial match on a tool call's arguments. A leaf is a literal (deep equality) or a `ValueMatch`. */
export type ArgsMatch = { [argument: string]: Json | ValueMatch };

export type TextMatch = { contains: string | string[]; caseSensitive?: boolean } | { matches: string; flags?: string };

/** The tool was called, with matching arguments, between `times.min` (default 1) and `times.max` times. */
export interface ToolCheck {
    tool: string;
    args?: ArgsMatch;
    times?: Range;
}
/** No tool outside this list was called. An empty list: no tool at all. */
export interface OnlyToolsCheck {
    onlyTools: string[];
}
/** Some reply in scope matches. */
export interface TextCheck {
    text: TextMatch;
}
/** A fact the project's plugin computed. `signal` is a path: "offered", "booking.startsAt", "offered[1].label". */
export type SignalCheck = { signal: string } & ValueMatch;
/** A yes or no question for the judge model. Yes passes, "cannot tell" is inconclusive. Never under `safety`. */
export interface JudgeCheck {
    judge: string;
}

/** Checks that code decides. Only these may stand under `safety`, in `choose.when` and in `simulate.until`. */
export type CodeCheck =
    | ToolCheck
    | OnlyToolsCheck
    | TextCheck
    | SignalCheck
    | { anyOf: Record<string, CodeCheck> }
    | { allOf: CodeCheck[] }
    | { not: CodeCheck };

/** Every check. `anyOf` branches have names; the verdict records which branch passed. */
export type Check = CodeCheck | JudgeCheck | { anyOf: Record<string, Check> } | { allOf: Check[] } | { not: Check };

export type Expectation =
    | { id: string; severity: "safety"; check: CodeCheck }
    | { id: string; severity: "gate" | "advisory"; check: Check };

// ── Steps and documents ──────────────────────────────────────────────────────

/** One scripted user turn. */
export interface ScriptedStep {
    /**
     * Names bound before this turn is sent: name → a path into the signals of the PREVIOUS turn ("offered[1]").
     * A binding lives to the end of the conversation. A path that does not resolve is a gate failure of the previous
     * turn (id "binding:<name>"), and the conversation stops.
     */
    bind?: Record<string, string>;
    /** The user's text. `{{name.path}}` reads a binding. */
    user: string;
    expect?: Expectation[];
}

interface ChooseBranchBase {
    /** Default: the 1-based position, or "otherwise". */
    name?: string;
    /** Bindings made here are visible only inside this branch. */
    bind?: Record<string, string>;
    user: string;
    expect?: Expectation[];
}
export interface WhenBranch extends ChooseBranchBase {
    /** Evaluated on the previous turn. Code checks only. */
    when: CodeCheck;
}
export interface OtherwiseBranch extends ChooseBranchBase {
    otherwise: true;
}

/** The next user turn picked by the previous turn: the first branch whose `when` passes, else `otherwise`. */
export interface ChooseStep {
    choose: (WhenBranch | OtherwiseBranch)[];
}

/** A block of turns written by a simulated user. It ends at `until`, at the stop word, or at `maxTurns`. */
export interface SimulatedStep {
    simulate: {
        /** Who the user is, in the second person: "You are a 67-year-old patient who writes short messages." */
        persona: string;
        /** What the user wants. */
        goal: string;
        /** 1 to 20. */
        maxTurns: number;
        /** The goal is reached: checked after every simulated turn. Code checks only. */
        until?: CodeCheck;
    };
    /** Checked on every simulated turn. */
    expect?: Expectation[];
}

export type Step = ScriptedStep | ChooseStep | SimulatedStep;

/** The scenario as data: validated, printed, hashed, stored in the manifest and read from stdin. */
export interface ScenarioDoc {
    id: string;
    title: string;
    tags: string[];
    /** The setup after the system's setup schema (defaults filled). */
    setup: Json;
    steps: Step[];
    /** Checked on every turn. The project's `always` list is appended to it. */
    always: Expectation[];
    /** Checked once after the last turn, on the whole conversation. */
    final: Expectation[];
    /** The share of completed repeats that must pass. Wins over the matrix's rate. */
    passRate?: number;
}

/** A validated scenario with its identity. Only `defineEvalScenario` and `parseScenarios` make one. */
export interface Scenario {
    readonly kind: "eval-scenario";
    readonly doc: ScenarioDoc;
    /** sha256 of the canonical JSON of `doc`, 16 hex characters. The resume and comparability key. */
    readonly hash: string;
    readonly origin: ScenarioOrigin;
}
export type ScenarioOrigin = "file" | "stdin" | "flags" | "manifest";

export interface MatrixDoc {
    id: string;
    /** "all", a list of scenario ids, or every scenario that has at least one of the tags. */
    scenarios: "all" | string[] | { tags: string[] };
    models: string[];
    /** Default: the system's first variant. */
    variants?: string[];
    repeats: number;
    /** Default 1: every completed repeat passes. */
    passRate?: number;
    /** A larger share of planned conversations without a result makes the cell "errored". Default 0.1. */
    maxErrorRate?: number;
    /** No new conversation opens once the finished ones cost more than this. */
    maxCostUsd?: number;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export interface ScenarioIssue {
    /** "0.steps.1.expect.0.check.tool" */
    path: string;
    message: string;
}

export type EvalConfigErrorCode =
    | "invalid-scenario"
    | "invalid-matrix"
    | "unknown-scenario"
    | "unknown-model"
    | "unknown-variant"
    | "unknown-matrix"
    | "plan-changed"
    | "unknown-run"
    | "bad-option"
    | "unsupported";

/** A wrong call or a wrong definition: exit code 2, printed as `{ schema: "eval-error/1", error, message, issues }`. */
export class EvalConfigError extends Error {
    readonly code: EvalConfigErrorCode;
    readonly issues: ScenarioIssue[];

    constructor(code: EvalConfigErrorCode, message: string, issues: ScenarioIssue[] = []) {
        super(message);
        this.name = "EvalConfigError";
        this.code = code;
        this.issues = issues;
    }
}

// ── JSON, canonical form, hash ───────────────────────────────────────────────

const JsonSchema = z.json();

/** A plain JSON copy of a value (undefined properties dropped). Throws when the value is not JSON. */
export function toJson(value: unknown): Json {
    const text = JSON.stringify(value);
    if (text === undefined) {
        throw new Error("not a JSON value");
    }
    const parsed: unknown = JSON.parse(text);
    return JsonSchema.parse(parsed);
}

// lint-rules-ignore: this separately vendored Node/Zod-only core owns its object guard; importing a GenesisTools helper breaks its approved portable boundary.
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
    return isRecord(value);
}

/** JSON with sorted keys and no undefined properties: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (!isRecord(value)) {
        return value;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) {
            sorted[key] = sortKeys(value[key]);
        }
    }
    return sorted;
}

export function sha256(text: string, length: number): string {
    return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function hashDoc(doc: ScenarioDoc): string {
    return sha256(canonicalJson(doc), 16);
}

// ── Paths ────────────────────────────────────────────────────────────────────

export type PathSegment = string | number;

const PathPattern = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/;
const SegmentPattern = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g;

/** "offered[1].label" → ["offered", 1, "label"]; null when the path is malformed. */
export function parsePath(path: string): PathSegment[] | null {
    const match = PathPattern.exec(path);
    if (!match) {
        return null;
    }
    const segments: PathSegment[] = [match[1]];
    for (const part of match[2].matchAll(SegmentPattern)) {
        segments.push(part[1] !== undefined ? part[1] : Number(part[2]));
    }
    return segments;
}

function formatPath(segments: readonly PathSegment[]): string {
    return segments.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join("");
}

/** Reads a path; `found: false` with the reason when a step of it is missing. */
export function readPath(
    root: Json,
    segments: readonly PathSegment[]
): { found: true; value: Json } | { found: false; reason: string } {
    let value: Json = root;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const where = formatPath(segments.slice(0, i)) || "the signals";
        if (typeof segment === "number") {
            if (!Array.isArray(value)) {
                return { found: false, reason: `${where} is ${describeJson(value)}, not a list` };
            }
            if (segment >= value.length) {
                return {
                    found: false,
                    reason: `${where} has ${value.length} item${value.length === 1 ? "" : "s"}, no [${segment}]`,
                };
            }
            value = value[segment];
        } else {
            if (!isJsonObject(value)) {
                return { found: false, reason: `${where} is ${describeJson(value)}, not an object` };
            }
            if (!(segment in value)) {
                return { found: false, reason: `${where} has no "${segment}"` };
            }
            value = value[segment];
        }
    }
    return { found: true, value };
}

function describeJson(value: Json): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "a list";
    }
    return typeof value === "object" ? "an object" : JSON.stringify(value);
}

/** The schema types the path walker knows. Anything else (unknown, record, union) accepts any further path. */
function unwrapSchema(schema: z.core.$ZodType): z.core.$ZodType {
    let current = schema;
    for (;;) {
        if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
            current = current.unwrap();
        } else if (current instanceof z.ZodDefault || current instanceof z.ZodReadonly) {
            current = current.unwrap();
        } else {
            return current;
        }
    }
}

function isLeafSchema(schema: z.core.$ZodType): boolean {
    return (
        schema instanceof z.ZodString ||
        schema instanceof z.ZodNumber ||
        schema instanceof z.ZodBoolean ||
        schema instanceof z.ZodEnum ||
        schema instanceof z.ZodLiteral
    );
}

/** Checks a path against the signals' object schema. Returns an English message for the issue list, or null. */
function checkPathAgainstShape(
    shape: Readonly<Record<string, z.ZodType>>,
    segments: readonly PathSegment[]
): string | null {
    const [first, ...rest] = segments;
    if (typeof first !== "string" || !(first in shape)) {
        return `unknown signal "${String(first)}"; known: ${Object.keys(shape).join(", ")}`;
    }
    let schema = unwrapSchema(shape[first]);
    for (let i = 0; i < rest.length; i++) {
        const segment = rest[i];
        const where = formatPath(segments.slice(0, i + 1));
        if (schema instanceof z.ZodObject) {
            const fields: Record<string, z.core.$ZodType> = schema.shape;
            if (typeof segment === "number") {
                return `${where} is an object, not a list`;
            }
            if (!(segment in fields)) {
                return `${where} has no field "${segment}"; known: ${Object.keys(fields).join(", ")}`;
            }
            schema = unwrapSchema(fields[segment]);
        } else if (schema instanceof z.ZodArray) {
            if (typeof segment !== "number") {
                return `${where} is a list; use ${where}[n]`;
            }
            schema = unwrapSchema(schema.element);
        } else if (isLeafSchema(schema)) {
            return `${where} is a single value; it has no "${typeof segment === "number" ? `[${segment}]` : segment}"`;
        } else {
            return null;
        }
    }
    return null;
}

// ── Templates and bindings ───────────────────────────────────────────────────

/** The values bound so far in one conversation: name → the JSON value its path resolved to. */
export type Bindings = Readonly<Record<string, Json>>;

const TemplatePattern = /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\s*\}\}/g;
const WholeTemplatePattern = /^\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\s*\}\}$/;

function templatePaths(text: string): string[] {
    return [...text.matchAll(TemplatePattern)].map((m) => m[1]);
}

/** Resolves `bind` against the previous turn's signals. Pure. */
export function resolveBindings(
    bind: Readonly<Record<string, string>>,
    previousSignals: Json
): { ok: true; values: Record<string, Json> } | { ok: false; name: string; path: string; reason: string } {
    const values: Record<string, Json> = {};
    for (const [name, path] of Object.entries(bind)) {
        const segments = parsePath(path);
        if (!segments) {
            return { ok: false, name, path, reason: `"${path}" is not a path` };
        }
        const read = readPath(previousSignals, segments);
        if (!read.found) {
            return { ok: false, name, path, reason: `needed ${path}; ${read.reason}` };
        }
        values[name] = read.value;
    }
    return { ok: true, values };
}

function lookupTemplate(path: string, bindings: Bindings): Json | undefined {
    const segments = parsePath(path);
    if (!segments) {
        return undefined;
    }
    const [name, ...rest] = segments;
    if (typeof name !== "string" || !(name in bindings)) {
        return undefined;
    }
    const read = readPath(bindings[name], rest);
    return read.found ? read.value : undefined;
}

/** Fills every `{{name.path}}` in a text. A value that is not a string is written as JSON. */
export function fillText(text: string, bindings: Bindings): string {
    return text.replace(TemplatePattern, (whole, path: string) => {
        const value = lookupTemplate(path, bindings);
        if (value === undefined) {
            return whole;
        }
        return typeof value === "string" ? value : JSON.stringify(value);
    });
}

/** A string that is one template alone becomes the bound value itself (a number stays a number). */
function fillJson(value: Json, bindings: Bindings): Json {
    if (typeof value === "string") {
        const whole = WholeTemplatePattern.exec(value);
        if (whole) {
            const bound = lookupTemplate(whole[1], bindings);
            if (bound !== undefined) {
                return bound;
            }
        }
        return fillText(value, bindings);
    }
    if (Array.isArray(value)) {
        return value.map((item) => fillJson(item, bindings));
    }
    if (isJsonObject(value)) {
        const out: JsonObject = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = fillJson(item, bindings);
        }
        return out;
    }
    return value;
}

function fillMatch(match: ValueMatch, bindings: Bindings): ValueMatch {
    if ("is" in match) {
        return { is: fillJson(match.is, bindings) };
    }
    if ("oneOf" in match) {
        return { oneOf: match.oneOf.map((item) => fillJson(item, bindings)) };
    }
    if ("matches" in match) {
        return { matches: fillText(match.matches, bindings), flags: match.flags };
    }
    if ("instant" in match) {
        return { instant: fillText(match.instant, bindings) };
    }
    return match;
}

/** Fills `{{name.path}}` in a check's strings. Pure. Validation made a miss impossible. */
export function fillCheck(check: Check, bindings: Bindings): Check {
    if ("anyOf" in check) {
        const branches: Record<string, Check> = {};
        for (const [name, branch] of Object.entries(check.anyOf)) {
            branches[name] = fillCheck(branch, bindings);
        }
        return { anyOf: branches };
    }
    if ("allOf" in check) {
        return { allOf: check.allOf.map((child) => fillCheck(child, bindings)) };
    }
    if ("not" in check) {
        return { not: fillCheck(check.not, bindings) };
    }
    if ("judge" in check) {
        return { judge: fillText(check.judge, bindings) };
    }
    if ("signal" in check) {
        const { signal, ...match } = check;
        return { signal, ...fillMatch(match, bindings) };
    }
    if ("text" in check) {
        const text = check.text;
        if ("contains" in text) {
            const contains = Array.isArray(text.contains)
                ? text.contains.map((needle) => fillText(needle, bindings))
                : fillText(text.contains, bindings);
            return { text: { contains, caseSensitive: text.caseSensitive } };
        }
        return { text: { matches: fillText(text.matches, bindings), flags: text.flags } };
    }
    if ("tool" in check && check.args) {
        const args: ArgsMatch = {};
        for (const [name, leaf] of Object.entries(check.args)) {
            args[name] = isMatchLeaf(leaf) ? fillMatch(leaf, bindings) : fillJson(leaf, bindings);
        }
        return { ...check, args };
    }
    return check;
}

/** An argument leaf that is a matcher: a non-empty object whose keys are all matcher keys. */
export function isMatchLeaf(leaf: Json | ValueMatch): leaf is ValueMatch {
    if (!isRecord(leaf)) {
        return false;
    }
    const keys = Object.keys(leaf);
    return keys.length > 0 && keys.every((key) => MatcherKeys.has(key));
}

// ── Parsing and validation ───────────────────────────────────────────────────

/** What validation needs to know about a system. `null` in `parseScenarios`: structure only, no names checked. */
export interface Vocabulary {
    tools: readonly string[];
    setup: z.ZodType<unknown>;
    signals: { readonly shape: Readonly<Record<string, z.ZodType>> };
}

const MatcherKeys = new Set(["is", "oneOf", "matches", "flags", "min", "max", "size", "instant", "exists"]);
const CheckKinds = ["tool", "onlyTools", "text", "signal", "judge", "anyOf", "allOf", "not"] as const;
const IdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ParseContext {
    issues: ScenarioIssue[];
    vocabulary: Vocabulary | null;
    /** Names bound so far, with the signal path each one reads. */
    bound: Map<string, readonly PathSegment[]>;
}

/** Records an issue. Returns null, so a parser can `return issue(…)`. */
function issue(ctx: ParseContext, path: readonly PathSegment[], message: string): null {
    ctx.issues.push({ path: path.join("."), message });
    return null;
}

function zodIssues(ctx: ParseContext, path: readonly PathSegment[], error: z.ZodError): null {
    for (const item of error.issues) {
        const segments = item.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
        issue(ctx, [...path, ...segments], item.message);
    }
    return null;
}

function checkRegex(ctx: ParseContext, path: readonly PathSegment[], source: string, flags: string | undefined): void {
    try {
        new RegExp(source, flags);
    } catch (error) {
        issue(ctx, path, `not a regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const RangeSchema = z.strictObject({ min: z.number().optional(), max: z.number().optional() });

function parseValueMatch(
    input: Record<string, unknown>,
    ctx: ParseContext,
    path: readonly PathSegment[]
): ValueMatch | null {
    const keys = Object.keys(input).filter((key) => MatcherKeys.has(key));
    const families = new Set(keys.map((key) => (key === "flags" ? "matches" : key === "max" ? "min" : key)));
    if (families.size !== 1) {
        issue(
            ctx,
            path,
            `write exactly one matcher: is, oneOf, matches, min/max, size, instant or exists (got ${keys.join(", ") || "none"})`
        );
        return null;
    }
    const [family] = families;
    const unknownKeys = Object.keys(input).filter((key) => !MatcherKeys.has(key));
    if (unknownKeys.length) {
        issue(ctx, path, `unknown key ${unknownKeys.map((k) => `"${k}"`).join(", ")}`);
        return null;
    }
    const json = JsonSchema.safeParse(input);
    if (!json.success) {
        issue(ctx, path, "a matcher holds only JSON values");
        return null;
    }
    switch (family) {
        case "is":
            return { is: toJson(input.is) };
        case "oneOf":
            if (!Array.isArray(input.oneOf)) {
                return issue(ctx, [...path, "oneOf"], "expected a list");
            }
            return { oneOf: input.oneOf.map(toJson) };
        case "matches": {
            if (typeof input.matches !== "string") {
                return issue(ctx, [...path, "matches"], "expected a string");
            }
            if (input.flags !== undefined && typeof input.flags !== "string") {
                return issue(ctx, [...path, "flags"], "expected a string");
            }
            const flags = typeof input.flags === "string" ? input.flags : undefined;
            if (!templatePaths(input.matches).length) {
                checkRegex(ctx, [...path, "matches"], input.matches, flags);
            }
            return flags === undefined ? { matches: input.matches } : { matches: input.matches, flags };
        }
        case "min": {
            const range = RangeSchema.safeParse({ min: input.min, max: input.max });
            if (!range.success) {
                return zodIssues(ctx, path, range.error);
            }
            const { min, max } = range.data;
            if (min !== undefined) {
                return max === undefined ? { min } : { min, max };
            }
            if (max !== undefined) {
                return { max };
            }
            return null;
        }
        case "size": {
            const range = RangeSchema.safeParse(input.size);
            if (!range.success) {
                return zodIssues(ctx, [...path, "size"], range.error);
            }
            return { size: range.data };
        }
        case "instant":
            if (typeof input.instant !== "string") {
                return issue(ctx, [...path, "instant"], "expected a string");
            }
            return { instant: input.instant };
        case "exists":
            if (typeof input.exists !== "boolean") {
                return issue(ctx, [...path, "exists"], "expected true or false");
            }
            return { exists: input.exists };
        default:
            return null;
    }
}

const TextSchema = z.union([
    z.strictObject({
        contains: z.union([z.string(), z.array(z.string()).min(1)]),
        caseSensitive: z.boolean().optional(),
    }),
    z.strictObject({ matches: z.string(), flags: z.string().optional() }),
]);

function checkTemplates(ctx: ParseContext, path: readonly PathSegment[], value: unknown): void {
    if (typeof value === "string") {
        for (const templatePath of templatePaths(value)) {
            checkTemplatePath(ctx, path, templatePath);
        }
    } else if (Array.isArray(value)) {
        value.forEach((item) => {
            checkTemplates(ctx, path, item);
        });
    } else if (isRecord(value)) {
        for (const item of Object.values(value)) {
            checkTemplates(ctx, path, item);
        }
    }
}

function checkTemplatePath(ctx: ParseContext, path: readonly PathSegment[], templatePath: string): void {
    const segments = parsePath(templatePath);
    const name = segments?.[0];
    if (!segments || typeof name !== "string") {
        return void issue(ctx, path, `"{{${templatePath}}}" is not a template`);
    }
    const boundPath = ctx.bound.get(name);
    if (!boundPath) {
        const known = [...ctx.bound.keys()];
        return void issue(
            ctx,
            path,
            `"{{${templatePath}}}" reads "${name}", which no earlier bind makes${known.length ? `; bound: ${known.join(", ")}` : ""}`
        );
    }
    if (ctx.vocabulary) {
        const problem = checkPathAgainstShape(ctx.vocabulary.signals.shape, [...boundPath, ...segments.slice(1)]);
        if (problem) {
            issue(ctx, path, `"{{${templatePath}}}": ${problem}`);
        }
    }
}

function checkSignalPath(ctx: ParseContext, path: readonly PathSegment[], signalPath: string): void {
    const segments = parsePath(signalPath);
    if (!segments) {
        return void issue(ctx, path, `"${signalPath}" is not a signal path (name, .field, [n])`);
    }
    if (!ctx.vocabulary) {
        return;
    }
    const problem = checkPathAgainstShape(ctx.vocabulary.signals.shape, segments);
    if (problem) {
        issue(ctx, path, problem);
    }
}

function checkToolName(ctx: ParseContext, path: readonly PathSegment[], name: string): void {
    if (ctx.vocabulary && !ctx.vocabulary.tools.includes(name)) {
        issue(ctx, path, `unknown tool "${name}"; known: ${ctx.vocabulary.tools.join(", ")}`);
    }
}

/**
 * Parses one check. `codeOnly`: a judge anywhere inside is an issue (safety expectations, `when`, `until`).
 * Returns null when the check had issues (they are in `ctx.issues`).
 */
function parseCheck(
    input: unknown,
    ctx: ParseContext,
    path: readonly PathSegment[],
    codeOnly: string | null
): Check | null {
    if (!isRecord(input)) {
        return issue(ctx, path, "a check is an object");
    }
    const kinds = CheckKinds.filter((kind) => kind in input);
    if (kinds.length !== 1) {
        issue(ctx, path, `a check has exactly one of ${CheckKinds.join(", ")} (got ${kinds.join(", ") || "none"})`);
        return null;
    }
    const [kind] = kinds;
    const allowed: Record<(typeof CheckKinds)[number], readonly string[]> = {
        tool: ["tool", "args", "times"],
        onlyTools: ["onlyTools"],
        text: ["text"],
        signal: ["signal", ...MatcherKeys],
        judge: ["judge"],
        anyOf: ["anyOf"],
        allOf: ["allOf"],
        not: ["not"],
    };
    const extra = Object.keys(input).filter((key) => !allowed[kind].includes(key));
    if (extra.length) {
        return issue(ctx, path, `unknown key ${extra.map((k) => `"${k}"`).join(", ")} in a ${kind} check`);
    }

    switch (kind) {
        case "tool": {
            if (typeof input.tool !== "string") {
                return issue(ctx, [...path, "tool"], "expected a tool name");
            }
            checkToolName(ctx, [...path, "tool"], input.tool);
            const check: ToolCheck = { tool: input.tool };
            if (input.args !== undefined) {
                if (!isRecord(input.args)) {
                    return issue(ctx, [...path, "args"], "expected an object");
                }
                const args: ArgsMatch = {};
                for (const [name, leaf] of Object.entries(input.args)) {
                    const leafPath = [...path, "args", name];
                    if (
                        isRecord(leaf) &&
                        Object.keys(leaf).length > 0 &&
                        Object.keys(leaf).every((key) => MatcherKeys.has(key))
                    ) {
                        const match = parseValueMatch(leaf, ctx, leafPath);
                        if (match) {
                            args[name] = match;
                        }
                    } else {
                        const json = JsonSchema.safeParse(leaf);
                        if (!json.success) {
                            issue(ctx, leafPath, "expected a JSON value or a matcher");
                        } else {
                            args[name] = toJson(leaf);
                        }
                    }
                }
                check.args = args;
            }
            if (input.times !== undefined) {
                const times = RangeSchema.safeParse(input.times);
                if (!times.success) {
                    zodIssues(ctx, [...path, "times"], times.error);
                } else {
                    check.times = times.data;
                }
            }
            checkTemplates(ctx, path, check.args);
            return check;
        }
        case "onlyTools": {
            const names = z.array(z.string()).safeParse(input.onlyTools);
            if (!names.success) {
                return issue(ctx, [...path, "onlyTools"], "expected a list of tool names");
            }
            names.data.forEach((name, i) => {
                checkToolName(ctx, [...path, "onlyTools", i], name);
            });
            return { onlyTools: names.data };
        }
        case "text": {
            const text = TextSchema.safeParse(input.text);
            if (!text.success) {
                issue(
                    ctx,
                    [...path, "text"],
                    "expected { contains: string | string[], caseSensitive? } or { matches, flags? }"
                );
                return null;
            }
            if ("matches" in text.data && !templatePaths(text.data.matches).length) {
                checkRegex(ctx, [...path, "text", "matches"], text.data.matches, text.data.flags);
            }
            checkTemplates(ctx, path, text.data);
            return { text: text.data };
        }
        case "signal": {
            if (typeof input.signal !== "string") {
                return issue(ctx, [...path, "signal"], "expected a signal path");
            }
            checkSignalPath(ctx, [...path, "signal"], input.signal);
            const { signal, ...rest } = input;
            const match = parseValueMatch(rest, ctx, path);
            if (!match) {
                return null;
            }
            checkTemplates(ctx, path, match);
            return { signal, ...match };
        }
        case "judge": {
            if (codeOnly) {
                return issue(
                    ctx,
                    [...path, "judge"],
                    `${codeOnly} takes only checks that code decides; a judge is not allowed here`
                );
            }
            if (typeof input.judge !== "string" || !input.judge.trim()) {
                return issue(ctx, [...path, "judge"], "expected a question");
            }
            checkTemplates(ctx, path, input.judge);
            return { judge: input.judge };
        }
        case "anyOf": {
            const raw = input.anyOf;
            const entries: [string, unknown][] = Array.isArray(raw)
                ? raw.map((branch, i) => [String(i + 1), branch])
                : isRecord(raw)
                  ? Object.entries(raw)
                  : [];
            if (entries.length < 1) {
                return issue(ctx, [...path, "anyOf"], "expected a non-empty list or an object of named branches");
            }
            const branches: Record<string, Check> = {};
            let ok = true;
            for (const [name, branch] of entries) {
                if (!IdPattern.test(name)) {
                    issue(ctx, [...path, "anyOf", name], `a branch name is letters, digits, ".", "_" or "-"`);
                }
                const parsed = parseCheck(branch, ctx, [...path, "anyOf", name], codeOnly);
                if (parsed) {
                    branches[name] = parsed;
                } else {
                    ok = false;
                }
            }
            return ok ? { anyOf: branches } : null;
        }
        case "allOf": {
            if (!Array.isArray(input.allOf) || !input.allOf.length) {
                return issue(ctx, [...path, "allOf"], "expected a non-empty list");
            }
            const children = input.allOf.map((child, i) => parseCheck(child, ctx, [...path, "allOf", i], codeOnly));
            const parsed = children.filter((child): child is Check => child !== null);
            return parsed.length === children.length ? { allOf: parsed } : null;
        }
        case "not": {
            const inner = parseCheck(input.not, ctx, [...path, "not"], codeOnly);
            return inner ? { not: inner } : null;
        }
    }
}

/** Narrows a parsed check to `CodeCheck`. Validation with `codeOnly` already refused judges; this proves it to the compiler. */
function asCodeCheck(check: Check): CodeCheck | null {
    if ("judge" in check) {
        return null;
    }
    if ("anyOf" in check) {
        const branches: Record<string, CodeCheck> = {};
        for (const [name, branch] of Object.entries(check.anyOf)) {
            const code = asCodeCheck(branch);
            if (!code) {
                return null;
            }
            branches[name] = code;
        }
        return { anyOf: branches };
    }
    if ("allOf" in check) {
        const children: CodeCheck[] = [];
        for (const child of check.allOf) {
            const code = asCodeCheck(child);
            if (!code) {
                return null;
            }
            children.push(code);
        }
        return { allOf: children };
    }
    if ("not" in check) {
        const inner = asCodeCheck(check.not);
        return inner ? { not: inner } : null;
    }
    return check;
}

/** True when a judge stands anywhere in the check. */
export function containsJudge(check: Check): boolean {
    return asCodeCheck(check) === null;
}

const ExpectationShape = z.strictObject({
    id: z.string().regex(IdPattern, 'an id is letters, digits, ".", "_" or "-"').optional(),
    severity: z.enum(Severities).default("gate"),
    check: z.unknown().optional(),
});

function parseExpectations(
    input: unknown,
    ctx: ParseContext,
    path: readonly PathSegment[],
    defaultId: (index: number) => string
): Expectation[] {
    if (input === undefined) {
        return [];
    }
    if (!Array.isArray(input)) {
        issue(ctx, path, "expected a list of expectations");
        return [];
    }
    const out: Expectation[] = [];
    input.forEach((raw, i) => {
        const shape = ExpectationShape.safeParse(raw);
        if (!shape.success) {
            zodIssues(ctx, [...path, i], shape.error);
            return;
        }
        const id = shape.data.id ?? defaultId(i + 1);
        const checkPath = [...path, i, "check"];
        if (shape.data.severity === "safety") {
            const parsed = parseCheck(shape.data.check, ctx, checkPath, "a safety expectation");
            const code = parsed && asCodeCheck(parsed);
            if (code) {
                out.push({ id, severity: "safety", check: code });
            }
        } else {
            const parsed = parseCheck(shape.data.check, ctx, checkPath, null);
            if (parsed) {
                out.push({ id, severity: shape.data.severity, check: parsed });
            }
        }
    });
    return out;
}

const BindShape = z.record(z.string().regex(/^[A-Za-z_$][\w$]*$/, "a binding name is an identifier"), z.string());

function parseBind(
    input: unknown,
    ctx: ParseContext,
    path: readonly PathSegment[],
    first: boolean
): Record<string, string> | undefined {
    if (input === undefined) {
        return undefined;
    }
    if (first) {
        issue(ctx, path, "the first step has no previous turn to bind from");
        return undefined;
    }
    const bind = BindShape.safeParse(input);
    if (!bind.success) {
        zodIssues(ctx, path, bind.error);
        return undefined;
    }
    for (const [name, signalPath] of Object.entries(bind.data)) {
        const segments = parsePath(signalPath);
        if (!segments) {
            issue(ctx, [...path, name], `"${signalPath}" is not a signal path`);
            continue;
        }
        checkSignalPath(ctx, [...path, name], signalPath);
        ctx.bound.set(name, segments);
    }
    return bind.data;
}

const ScriptedShape = z.strictObject({
    bind: z.unknown().optional(),
    user: z.string().min(1),
    expect: z.unknown().optional(),
});
const BranchShape = z.strictObject({
    name: z.string().regex(IdPattern).optional(),
    when: z.unknown().optional(),
    otherwise: z.literal(true).optional(),
    bind: z.unknown().optional(),
    user: z.string().min(1),
    expect: z.unknown().optional(),
});
const SimulateShape = z.strictObject({
    simulate: z.strictObject({
        persona: z.string().min(1),
        goal: z.string().min(1),
        maxTurns: z.number().int().min(1).max(20),
        until: z.unknown().optional(),
    }),
    expect: z.unknown().optional(),
});

function parseStep(input: unknown, index: number, ctx: ParseContext, path: readonly PathSegment[]): Step | null {
    const stepId = `s${index + 1}`;
    if (!isRecord(input)) {
        return issue(ctx, path, "a step is an object");
    }
    if ("choose" in input) {
        if (index === 0) {
            return issue(ctx, [...path, "choose"], "the first step has no previous turn to choose on");
        }
        const extra = Object.keys(input).filter((key) => key !== "choose");
        if (extra.length) {
            return issue(ctx, path, `unknown key ${extra.map((k) => `"${k}"`).join(", ")} beside "choose"`);
        }
        if (!Array.isArray(input.choose) || !input.choose.length) {
            return issue(ctx, [...path, "choose"], "expected a non-empty list of branches");
        }
        const branches: (WhenBranch | OtherwiseBranch)[] = [];
        const names = new Set<string>();
        const outer = new Map(ctx.bound);
        const rawBranches: unknown[] = input.choose;
        rawBranches.forEach((raw, i) => {
            const branchPath = [...path, "choose", i];
            const shape = BranchShape.safeParse(raw);
            if (!shape.success) {
                zodIssues(ctx, branchPath, shape.error);
                return;
            }
            const branch = shape.data;
            const isOtherwise = branch.otherwise === true;
            if (isOtherwise === (branch.when !== undefined)) {
                issue(ctx, branchPath, `a branch has either "when" or "otherwise": true`);
                return;
            }
            if (isOtherwise && i !== rawBranches.length - 1) {
                issue(ctx, branchPath, `"otherwise" must be the last branch`);
            }
            const name = branch.name ?? (isOtherwise ? "otherwise" : String(i + 1));
            if (names.has(name)) {
                issue(ctx, [...branchPath, "name"], `branch name "${name}" is used twice`);
            }
            names.add(name);
            ctx.bound = new Map(outer);
            const when = isOtherwise ? null : parseCheck(branch.when, ctx, [...branchPath, "when"], "choose.when");
            const bind = parseBind(branch.bind, ctx, [...branchPath, "bind"], false);
            checkTemplates(ctx, [...branchPath, "user"], branch.user);
            const expect = parseExpectations(
                branch.expect,
                ctx,
                [...branchPath, "expect"],
                (n) => `${stepId}.${name}.e${n}`
            );
            const base = { name, ...(bind ? { bind } : {}), user: branch.user, expect };
            if (isOtherwise) {
                branches.push({ ...base, otherwise: true });
            } else {
                const code = when && asCodeCheck(when);
                if (code) {
                    branches.push({ ...base, when: code });
                }
            }
        });
        ctx.bound = outer;
        return { choose: branches };
    }
    if ("simulate" in input) {
        const shape = SimulateShape.safeParse(input);
        if (!shape.success) {
            return zodIssues(ctx, path, shape.error);
        }
        const { persona, goal, maxTurns, until } = shape.data.simulate;
        const step: SimulatedStep = {
            simulate: { persona, goal, maxTurns },
            expect: parseExpectations(shape.data.expect, ctx, [...path, "expect"], (n) => `${stepId}.e${n}`),
        };
        if (until !== undefined) {
            const parsed = parseCheck(until, ctx, [...path, "simulate", "until"], "simulate.until");
            const code = parsed && asCodeCheck(parsed);
            if (code) {
                step.simulate.until = code;
            }
        }
        return step;
    }
    const shape = ScriptedShape.safeParse(input);
    if (!shape.success) {
        return zodIssues(ctx, path, shape.error);
    }
    const bind = parseBind(shape.data.bind, ctx, [...path, "bind"], index === 0);
    checkTemplates(ctx, [...path, "user"], shape.data.user);
    const expect = parseExpectations(shape.data.expect, ctx, [...path, "expect"], (n) => `${stepId}.e${n}`);
    return { ...(bind ? { bind } : {}), user: shape.data.user, expect };
}

const ScenarioShape = z.strictObject({
    id: z.string().regex(IdPattern, 'an id is letters, digits, ".", "_" or "-"'),
    title: z.string().optional(),
    tags: z.array(z.string()).default([]),
    setup: z.unknown().optional(),
    steps: z.array(z.unknown()).min(1, "a scenario has at least one step"),
    always: z.unknown().optional(),
    final: z.unknown().optional(),
    passRate: z.number().gt(0).lte(1).optional(),
});

function expectationIds(doc: ScenarioDoc): string[] {
    const ids: string[] = [];
    for (const step of doc.steps) {
        if ("choose" in step) {
            step.choose.forEach((branch) => {
                ids.push(...(branch.expect ?? []).map((e) => e.id));
            });
        } else {
            ids.push(...(step.expect ?? []).map((e) => e.id));
        }
    }
    ids.push(...doc.always.map((e) => e.id), ...doc.final.map((e) => e.id));
    return ids;
}

/** Every expectation of a document, with the place it stands. */
export function allExpectations(doc: ScenarioDoc): Expectation[] {
    const out: Expectation[] = [];
    for (const step of doc.steps) {
        if ("choose" in step) {
            step.choose.forEach((branch) => {
                out.push(...(branch.expect ?? []));
            });
        } else {
            out.push(...(step.expect ?? []));
        }
    }
    return [...out, ...doc.always, ...doc.final];
}

function parseOne(
    input: unknown,
    ctx: ParseContext,
    path: readonly PathSegment[],
    extraAlways: readonly Expectation[]
): ScenarioDoc | null {
    const before = ctx.issues.length;
    const shape = ScenarioShape.safeParse(input);
    if (!shape.success) {
        return zodIssues(ctx, path, shape.error);
    }
    const raw = shape.data;
    ctx.bound = new Map();

    let setup: Json = toJson(raw.setup ?? {});
    if (ctx.vocabulary) {
        const parsed = ctx.vocabulary.setup.safeParse(raw.setup ?? {});
        if (!parsed.success) {
            zodIssues(ctx, [...path, "setup"], parsed.error);
        } else {
            try {
                setup = toJson(parsed.data);
            } catch {
                issue(ctx, [...path, "setup"], "the setup schema's output is not plain JSON");
            }
        }
    }

    const steps: Step[] = [];
    raw.steps.forEach((step, i) => {
        const parsed = parseStep(step, i, ctx, [...path, "steps", i]);
        if (parsed) {
            steps.push(parsed);
        }
    });
    const bindingsAtEnd = ctx.bound;
    ctx.bound = new Map();
    const always = parseExpectations(raw.always, ctx, [...path, "always"], (n) => `a${n}`);
    ctx.bound = bindingsAtEnd;
    const final = parseExpectations(raw.final, ctx, [...path, "final"], (n) => `f${n}`);

    const doc: ScenarioDoc = {
        id: raw.id,
        title: raw.title ?? raw.id,
        tags: raw.tags,
        setup,
        steps,
        always: [...always, ...extraAlways],
        final,
        ...(raw.passRate === undefined ? {} : { passRate: raw.passRate }),
    };
    const seen = new Set<string>();
    for (const id of expectationIds(doc)) {
        if (seen.has(id)) {
            issue(ctx, path, `expectation id "${id}" is used twice (the project's "always" ids count too)`);
        }
        seen.add(id);
    }
    return ctx.issues.length === before ? doc : null;
}

/**
 * The stdin boundary: unknown JSON (one scenario or an array) to validated scenarios, or every issue found.
 * Missing `title`, `tags`, `always`, `final`, `severity` (gate) and expectation ids ("s1.e2") take defaults.
 * `always` is appended to every scenario's own `always` (the project's list). Pass `vocabulary: null` to check the
 * structure only (reading a stored run).
 */
export function parseScenarios(
    input: unknown,
    vocabulary: Vocabulary | null,
    origin: ScenarioOrigin,
    options: { always?: readonly Expectation[] } = {}
): { ok: true; scenarios: Scenario[] } | { ok: false; issues: ScenarioIssue[] } {
    const ctx: ParseContext = { issues: [], vocabulary, bound: new Map() };
    const list = Array.isArray(input) ? input : [input];
    const docs: ScenarioDoc[] = [];
    list.forEach((item, i) => {
        const doc = parseOne(item, ctx, Array.isArray(input) ? [i] : [], options.always ?? []);
        if (doc) {
            docs.push(doc);
        }
    });
    const ids = new Set<string>();
    docs.forEach((doc) => {
        if (ids.has(doc.id)) {
            ctx.issues.push({ path: "", message: `scenario id "${doc.id}" is used twice` });
        }
        ids.add(doc.id);
    });
    if (ctx.issues.length) {
        return { ok: false, issues: ctx.issues };
    }
    return { ok: true, scenarios: docs.map((doc) => ({ kind: "eval-scenario", doc, hash: hashDoc(doc), origin })) };
}

/** Parses expectations alone (a project's `always` list). Throws `EvalConfigError` with every issue. */
export function parseExpectationList(input: unknown, vocabulary: Vocabulary, path: string): Expectation[] {
    const ctx: ParseContext = { issues: [], vocabulary, bound: new Map() };
    const list = parseExpectations(input, ctx, [path], (n) => `${path}${n}`);
    if (ctx.issues.length) {
        throw new EvalConfigError("invalid-scenario", `invalid ${path} expectations`, ctx.issues);
    }
    return list;
}

/** One scenario with the project's `always` list appended: a new document and a new hash. */
export function withAlways(scenario: Scenario, always: readonly Expectation[], vocabulary: Vocabulary): Scenario {
    if (!always.length) {
        return scenario;
    }
    const result = parseScenarios(scenario.doc, vocabulary, scenario.origin, { always });
    if (!result.ok) {
        throw new EvalConfigError(
            "invalid-scenario",
            `scenario "${scenario.doc.id}" with the project's always list`,
            result.issues
        );
    }
    return result.scenarios[0];
}

/** A value that claims to be a scenario (an export of a scenario file): validated again, never trusted. */
export function isScenarioLike(value: unknown): value is { kind: "eval-scenario"; doc: unknown; origin: unknown } {
    return isRecord(value) && value.kind === "eval-scenario" && "doc" in value;
}

// ── Matrices ─────────────────────────────────────────────────────────────────

const MatrixSchema = z.strictObject({
    id: z.string().regex(IdPattern),
    scenarios: z.union([
        z.literal("all"),
        z.array(z.string()).min(1),
        z.strictObject({ tags: z.array(z.string()).min(1) }),
    ]),
    models: z.array(z.string()).min(1),
    variants: z.array(z.string()).min(1).optional(),
    repeats: z.number().int().min(1).max(1000),
    passRate: z.number().gt(0).lte(1).optional(),
    maxErrorRate: z.number().min(0).lte(1).optional(),
    maxCostUsd: z.number().positive().optional(),
});

export function parseMatrix(input: unknown): MatrixDoc {
    const parsed = MatrixSchema.safeParse(input);
    if (!parsed.success) {
        const ctx: ParseContext = { issues: [], vocabulary: null, bound: new Map() };
        zodIssues(ctx, [], parsed.error);
        throw new EvalConfigError("invalid-matrix", "invalid matrix", ctx.issues);
    }
    return parsed.data;
}

// ── The typed builder ────────────────────────────────────────────────────────

/** A signal path: the name, then `.field` or `[n]` parts. */
export type SignalPath<TSignal extends string> = TSignal | `${TSignal}.${string}` | `${TSignal}[${number}]${string}`;

/**
 * The typed pen. Every method returns plain data. `TTool` and `TSignal` come from the system, so an unknown tool or
 * signal name is a compile error in a scenario file (and a validation issue on stdin).
 */
export interface CheckBuilder<TTool extends string, TSignal extends string> {
    tool(name: TTool, args?: ArgsMatch, times?: Range): ToolCheck;
    /** No tool call at all: `{ onlyTools: [] }`. */
    noTools(): OnlyToolsCheck;
    onlyTools(...names: TTool[]): OnlyToolsCheck;
    text(match: TextMatch): TextCheck;
    signal(path: SignalPath<TSignal>, match: ValueMatch): SignalCheck;
    judge(question: string): JudgeCheck;
    /** Named branches (`{ offers: …, asks: … }`), or a list whose branches are named "1", "2", … */
    anyOf<C extends Check>(branches: Readonly<Record<string, C>> | readonly C[]): { anyOf: Record<string, C> };
    allOf<const T extends readonly Check[]>(...checks: T): { allOf: T[number][] };
    not<C extends Check>(check: C): { not: C };
    /** Code checks only: a judge under `safety` does not compile. */
    safety(id: string, check: CodeCheck): Expectation;
    gate(id: string, check: Check): Expectation;
    advisory(id: string, check: Check): Expectation;
}

/** What a scenario file writes. `steps`, `always` and `final` may be builder callbacks or plain data. */
export interface ScenarioSpec<TSetup, TTool extends string, TSignal extends string> {
    id: string;
    title?: string;
    tags?: string[];
    /** Only what differs from the defaults of the system's setup schema. */
    setup?: Partial<TSetup>;
    steps: Step[] | ((s: CheckBuilder<TTool, TSignal>) => Step[]);
    always?: Expectation[] | ((s: CheckBuilder<TTool, TSignal>) => Expectation[]);
    final?: Expectation[] | ((s: CheckBuilder<TTool, TSignal>) => Expectation[]);
    passRate?: number;
}

export interface EvalKit<TSetup, TTool extends string, TSignal extends string> {
    /** Calls the builder callbacks once, validates, hashes. Throws `EvalConfigError` with every issue. */
    defineEvalScenario(spec: ScenarioSpec<TSetup, TTool, TSignal>): Scenario;
    /** Validates a matrix. Throws `EvalConfigError` ("invalid-matrix"). */
    defineEvalMatrix(matrix: MatrixDoc): MatrixDoc;
    /** The same builder as a value, for a project's own check constants. */
    check: CheckBuilder<TTool, TSignal>;
}

export function checkBuilder<TTool extends string, TSignal extends string>(): CheckBuilder<TTool, TSignal> {
    return {
        tool: (name, args, times) => ({ tool: name, ...(args ? { args } : {}), ...(times ? { times } : {}) }),
        noTools: () => ({ onlyTools: [] }),
        onlyTools: (...names) => ({ onlyTools: names }),
        text: (match) => ({ text: match }),
        signal: (path, match) => ({ signal: path, ...match }),
        judge: (question) => ({ judge: question }),
        anyOf: (branches) => ({ anyOf: nameBranches(branches) }),
        allOf: (...checks) => ({ allOf: [...checks] }),
        not: (check) => ({ not: check }),
        safety: (id, check) => ({ id, severity: "safety", check }),
        gate: (id, check) => ({ id, severity: "gate", check }),
        advisory: (id, check) => ({ id, severity: "advisory", check }),
    };
}

function isReadonlyArray<C>(value: Readonly<Record<string, C>> | readonly C[]): value is readonly C[] {
    return Array.isArray(value);
}

/** Branches given as a list are named "1", "2", … */
function nameBranches<C>(branches: Readonly<Record<string, C>> | readonly C[]): Record<string, C> {
    const named: Record<string, C> = {};
    if (isReadonlyArray(branches)) {
        branches.forEach((branch, i) => {
            named[String(i + 1)] = branch;
        });
    } else {
        for (const [name, branch] of Object.entries(branches)) {
            named[name] = branch;
        }
    }
    return named;
}

/** The definition functions of one system, typed by its tool names, its signal names and its setup. */
export function evalKit<TSetup, TSignals, TTool extends string, THandle, TResolved>(
    system: EvalSystem<TSetup, TSignals, TTool, THandle, TResolved>
): EvalKit<TSetup, TTool, keyof TSignals & string> {
    const check = checkBuilder<TTool, keyof TSignals & string>();
    const vocabulary: Vocabulary = system;
    return {
        check,
        defineEvalScenario(spec) {
            const run = <T>(
                value: T[] | ((s: CheckBuilder<TTool, keyof TSignals & string>) => T[]) | undefined
            ): T[] | undefined => (typeof value === "function" ? value(check) : value);
            const input = {
                id: spec.id,
                title: spec.title,
                tags: spec.tags,
                setup: spec.setup ?? {},
                steps: run(spec.steps),
                always: run(spec.always),
                final: run(spec.final),
                passRate: spec.passRate,
            };
            const result = parseScenarios(toJsonInput(input), vocabulary, "file");
            if (!result.ok) {
                const lines = result.issues.map((item) => `  ${item.path || "(scenario)"}: ${item.message}`).join("\n");
                throw new EvalConfigError(
                    "invalid-scenario",
                    `scenario "${spec.id}" is invalid:\n${lines}`,
                    result.issues
                );
            }
            return result.scenarios[0];
        },
        defineEvalMatrix: parseMatrix,
    };
}

/** Drops undefined properties, as the JSON form would. */
function toJsonInput(value: unknown): unknown {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
}
