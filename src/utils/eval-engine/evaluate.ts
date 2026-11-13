/**
 * What a verdict is and how verdicts combine. `evaluateCheck` is pure and three-valued; judge questions come back as
 * `needs`, and the thin loop `evaluateExpectations` asks them and evaluates again. `conversationOutcome` is the sticky
 * fold over every verdict of a conversation.
 */
import {
    type ArgsMatch,
    type Bindings,
    type Check,
    EvalConfigError,
    type Expectation,
    fillCheck,
    isJsonObject,
    isMatchLeaf,
    parsePath,
    readPath,
    type Severity,
    sha256,
    type TextMatch,
    toJson,
    type ValueMatch,
} from "./document";
import type { Json, ToolCall, Usage } from "./system";

/** Bumped when verdict semantics change. Runs with different values are not compared. */
export const RubricVersion = 1;

export type Result = "pass" | "fail" | "inconclusive";

export interface TranscriptLine {
    role: "user" | "assistant";
    text: string;
    toolCalls: ToolCall[];
}

/** What a check is evaluated against. Built by the conversation, never by a project. */
export interface Scope {
    kind: "turn" | "conversation";
    /** Turn scope: the 1-based turn. Conversation scope: the number of turns. */
    turn: number;
    /** Turn scope: this turn's calls. Conversation scope: every call of every turn. */
    toolCalls: ToolCall[];
    toolEvidence: "observed" | "unavailable";
    /** Turn scope: one reply. Conversation scope: every reply, in order. */
    replies: string[];
    /** Turn scope: this turn's signals. Conversation scope: the last turn's signals. */
    signals: Json;
    /** The conversation up to this scope's last turn, as the judge sees it. */
    transcript: TranscriptLine[];
}

/** One judge question on one scope. `key` is stable: sha256 of the question, the scope kind, the turn and the transcript. */
export interface JudgeRequest {
    key: string;
    question: string;
    scope: Scope;
}

export interface JudgeAnswer {
    result: Result;
    reason: string;
    usage: Usage;
}

/** The verdict of one check, as a tree that mirrors the check. */
export interface CheckVerdict {
    /** "tool find_free_slots", "signal offered", "anyOf", "judge", … */
    label: string;
    /** The branch name, for a child of an `anyOf`. */
    name?: string;
    result: Result;
    reason: string;
    /** For a passing `anyOf`: the name of the first branch that passed. */
    branch?: string;
    children?: CheckVerdict[];
}

/** Where an expectation came from. "binding" and "choose" are verdicts the engine adds when a dependent turn cannot be built. */
export type VerdictPlace = "turn" | "always" | "final" | "binding" | "choose";

export interface ExpectationVerdict {
    id: string;
    severity: Severity;
    place: VerdictPlace;
    /** The 1-based turn the verdict belongs to (the last turn for "final"). */
    turn: number;
    result: Result;
    reason: string;
    /** The check after the bindings were filled in, so the transcript shows the real values. */
    check: Json;
    /** The passing `anyOf` branches along the passing path, joined with "/" ("offers", "offers/today"); else null. */
    branch: string | null;
    tree: CheckVerdict;
}

// ── Matchers ─────────────────────────────────────────────────────────────────

function jsonEqual(a: Json, b: Json): boolean {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return (
            Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]))
        );
    }
    if (isJsonObject(a) && isJsonObject(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]));
    }
    return false;
}

function show(value: Json | undefined): string {
    if (value === undefined) {
        return "missing";
    }
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Matches one value. `undefined` is a missing value: only `{ exists: false }` passes on it. */
export function matchValue(value: Json | undefined, match: ValueMatch): { ok: boolean; reason: string } {
    if ("exists" in match) {
        const exists = value !== undefined && value !== null;
        return {
            ok: exists === match.exists,
            reason: `is ${show(value)}, expected ${match.exists ? "a value" : "no value"}`,
        };
    }
    if (value === undefined) {
        return { ok: false, reason: "is missing" };
    }
    if ("is" in match) {
        return { ok: jsonEqual(value, match.is), reason: `is ${show(value)}, expected ${show(match.is)}` };
    }
    if ("oneOf" in match) {
        return {
            ok: match.oneOf.some((item) => jsonEqual(value, item)),
            reason: `is ${show(value)}, expected one of ${show(match.oneOf)}`,
        };
    }
    if ("matches" in match) {
        if (typeof value !== "string") {
            return { ok: false, reason: `is ${show(value)}, not a string` };
        }
        try {
            return {
                ok: new RegExp(match.matches, match.flags).test(value),
                reason: `is ${show(value)}, expected to match /${match.matches}/`,
            };
        } catch (error) {
            throw new EvalConfigError("invalid-scenario", `invalid expanded regex: ${String(error)}`);
        }
    }
    if ("size" in match) {
        if (typeof value !== "string" && !Array.isArray(value)) {
            return { ok: false, reason: `is ${show(value)}, which has no size` };
        }
        return {
            ok: inRange(value.length, match.size),
            reason: `has size ${value.length}, expected ${rangeText(match.size)}`,
        };
    }
    if ("instant" in match) {
        const expected = Date.parse(match.instant);
        if (Number.isNaN(expected)) {
            return { ok: false, reason: `the expected instant "${match.instant}" is not a time` };
        }
        const actual = typeof value === "string" ? Date.parse(value) : NaN;
        return {
            ok: actual === expected,
            reason: `is ${show(value)}, expected the instant ${new Date(expected).toISOString()}`,
        };
    }
    if (typeof value !== "number") {
        return { ok: false, reason: `is ${show(value)}, not a number` };
    }
    return { ok: inRange(value, match), reason: `is ${value}, expected ${rangeText(match)}` };
}

function inRange(n: number, range: { min?: number; max?: number }): boolean {
    return (range.min === undefined || n >= range.min) && (range.max === undefined || n <= range.max);
}

function rangeText(range: { min?: number; max?: number }): string {
    if (range.min !== undefined && range.max !== undefined) {
        return range.min === range.max ? `${range.min}` : `${range.min} to ${range.max}`;
    }
    if (range.min !== undefined) {
        return `at least ${range.min}`;
    }
    return `at most ${range.max}`;
}

/** Every named argument must match; others are free. Returns the first mismatch. */
function matchArgs(input: Json, args: ArgsMatch | undefined): { ok: boolean; reason: string } {
    if (!args) {
        return { ok: true, reason: "" };
    }
    if (!isJsonObject(input)) {
        return { ok: false, reason: `the input is ${show(input)}, not an object` };
    }
    for (const [name, leaf] of Object.entries(args)) {
        const value = name in input ? input[name] : undefined;
        const result = isMatchLeaf(leaf)
            ? matchValue(value, leaf)
            : {
                  ok: value !== undefined && jsonEqual(value, leaf),
                  reason: `is ${show(value)}, expected ${show(leaf)}`,
              };
        if (!result.ok) {
            return { ok: false, reason: `${name} ${result.reason}` };
        }
    }
    return { ok: true, reason: "" };
}

function matchText(replies: string[], match: TextMatch): { ok: boolean; reason: string } {
    if ("contains" in match) {
        const needles = Array.isArray(match.contains) ? match.contains : [match.contains];
        const fold = (text: string) => (match.caseSensitive ? text : text.toLocaleLowerCase());
        const hit = replies.some((reply) => needles.some((needle) => fold(reply).includes(fold(needle))));
        return {
            ok: hit,
            reason: hit ? `the reply contains ${show(needles)}` : `no reply contains any of ${show(needles)}`,
        };
    }
    try {
        const pattern = new RegExp(match.matches, match.flags);
        const hit = replies.some((reply) => pattern.test(reply));
        return {
            ok: hit,
            reason: hit ? `the reply matches /${match.matches}/` : `no reply matches /${match.matches}/`,
        };
    } catch (error) {
        throw new EvalConfigError("invalid-scenario", `invalid expanded regex: ${String(error)}`);
    }
}

// ── evaluateCheck ────────────────────────────────────────────────────────────

const pass = (result: boolean): Result => (result ? "pass" : "fail");

function judgeKey(question: string, scope: Scope): string {
    return sha256(JSON.stringify([question, scope.kind, scope.turn, scope.transcript]), 16);
}

/**
 * Evaluates one check on one scope. Pure. `answers` holds the judge answers known so far; `needs` lists the judge
 * questions whose answer can still change the result (empty whenever the result is not inconclusive). So a passing
 * code branch of an `anyOf`, or a failing code child of an `allOf`, costs no judge call.
 */
export function evaluateCheck(
    check: Check,
    scope: Scope,
    answers: ReadonlyMap<string, JudgeAnswer>
): { verdict: CheckVerdict; needs: JudgeRequest[] } {
    if ("anyOf" in check) {
        const names = Object.keys(check.anyOf);
        const results = names.map((name) => {
            const child = evaluateCheck(check.anyOf[name], scope, answers);
            return { ...child, verdict: { ...child.verdict, name } };
        });
        const children = results.map((r) => r.verdict);
        const passed = children.find((c) => c.result === "pass");
        if (passed) {
            return {
                verdict: {
                    label: "anyOf",
                    result: "pass",
                    reason: `branch ${passed.name} passed: ${passed.reason}`,
                    branch: passed.name,
                    children,
                },
                needs: [],
            };
        }
        const reason = children.map((c) => `${c.name}: ${c.reason}`).join(" | ");
        if (children.some((c) => c.result === "inconclusive")) {
            return {
                verdict: { label: "anyOf", result: "inconclusive", reason, children },
                needs: results.flatMap((r) => r.needs),
            };
        }
        return {
            verdict: { label: "anyOf", result: "fail", reason: `no branch passed: ${reason}`, children },
            needs: [],
        };
    }
    if ("allOf" in check) {
        const results = check.allOf.map((child) => evaluateCheck(child, scope, answers));
        const children = results.map((r) => r.verdict);
        const failed = children.find((c) => c.result === "fail");
        if (failed) {
            return { verdict: { label: "allOf", result: "fail", reason: failed.reason, children }, needs: [] };
        }
        const open = children.filter((c) => c.result === "inconclusive");
        if (open.length) {
            return {
                verdict: {
                    label: "allOf",
                    result: "inconclusive",
                    reason: open.map((c) => c.reason).join(" | "),
                    children,
                },
                needs: results.flatMap((r) => r.needs),
            };
        }
        return {
            verdict: { label: "allOf", result: "pass", reason: children.map((c) => c.reason).join("; "), children },
            needs: [],
        };
    }
    if ("not" in check) {
        const inner = evaluateCheck(check.not, scope, answers);
        const result: Result =
            inner.verdict.result === "pass" ? "fail" : inner.verdict.result === "fail" ? "pass" : "inconclusive";
        return {
            verdict: { label: "not", result, reason: `not (${inner.verdict.reason})`, children: [inner.verdict] },
            needs: inner.needs,
        };
    }
    if ("judge" in check) {
        const key = judgeKey(check.judge, scope);
        const answer = answers.get(key);
        if (answer) {
            return { verdict: { label: "judge", result: answer.result, reason: answer.reason }, needs: [] };
        }
        return {
            verdict: { label: "judge", result: "inconclusive", reason: "waiting for the judge" },
            needs: [{ key, question: check.judge, scope }],
        };
    }
    if ("tool" in check) {
        const label = `tool ${check.tool}`;
        if (scope.toolEvidence === "unavailable") {
            return { verdict: { label, result: "inconclusive", reason: "tool calls were not observable" }, needs: [] };
        }
        const named = scope.toolCalls.filter((call) => call.name === check.tool);
        const matching = named.filter((call) => matchArgs(call.input, check.args).ok);
        const range = { min: check.times?.min ?? 1, max: check.times?.max };
        const ok = inRange(matching.length, range);
        let reason = `${check.tool} called ${matching.length} time${matching.length === 1 ? "" : "s"}${check.args ? " with matching arguments" : ""}, expected ${rangeText(range)}`;
        if (!ok && named.length > matching.length) {
            reason += `; ${matchArgs(named[0].input, check.args).reason}`;
        }
        return { verdict: { label, result: pass(ok), reason }, needs: [] };
    }
    if ("onlyTools" in check) {
        const label = check.onlyTools.length ? `onlyTools ${check.onlyTools.join(",")}` : "noTools";
        if (scope.toolEvidence === "unavailable") {
            return { verdict: { label, result: "inconclusive", reason: "tool calls were not observable" }, needs: [] };
        }
        const others = [
            ...new Set(scope.toolCalls.map((call) => call.name).filter((name) => !check.onlyTools.includes(name))),
        ];
        const reason = others.length
            ? `called ${others.join(", ")}`
            : scope.toolCalls.length
              ? "only allowed tools were called"
              : "no tool was called";
        return { verdict: { label, result: pass(!others.length), reason }, needs: [] };
    }
    if ("text" in check) {
        const result = matchText(scope.replies, check.text);
        return { verdict: { label: "text", result: pass(result.ok), reason: result.reason }, needs: [] };
    }
    const { signal, ...match } = check;
    const segments = parsePath(signal);
    const read = segments ? readPath(scope.signals, segments) : null;
    const value = read?.found ? read.value : undefined;
    const result = matchValue(value, match);
    const reason =
        read && !read.found && !("exists" in match)
            ? `signal ${signal}: ${read.reason}`
            : `signal ${signal} ${result.reason}`;
    return { verdict: { label: `signal ${signal}`, result: pass(result.ok), reason }, needs: [] };
}

/** The passing `anyOf` branches along the passing path of a verdict tree. */
function passingBranches(tree: CheckVerdict): string[] {
    if (tree.result !== "pass" || tree.label === "not") {
        return [];
    }
    if (tree.branch !== undefined) {
        const child = tree.children?.find((c) => c.name === tree.branch);
        return [tree.branch, ...(child ? passingBranches(child) : [])];
    }
    return (tree.children ?? []).flatMap(passingBranches);
}

export interface PlacedExpectation {
    expectation: Expectation;
    place: VerdictPlace;
}

const NoUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
    const sum: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
    if (a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined) {
        sum.cachedInputTokens = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
    }
    if (a.costUsd !== undefined || b.costUsd !== undefined) {
        sum.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
    }
    return sum;
}

export function emptyUsage(): Usage {
    return { ...NoUsage };
}

/**
 * Evaluates expectations on one scope and asks the judge for what is still open, until nothing is open.
 * `askJudge` must never throw: a judge that fails or is not configured answers "inconclusive".
 */
export async function evaluateExpectations(
    items: readonly PlacedExpectation[],
    scope: Scope,
    bindings: Bindings,
    askJudge: (request: JudgeRequest) => Promise<JudgeAnswer>
): Promise<{ verdicts: ExpectationVerdict[]; judgeUsage: Usage }> {
    const answers = new Map<string, JudgeAnswer>();
    const filled = items.map((item) => ({ ...item, check: fillCheck(item.expectation.check, bindings) }));
    let judgeUsage = emptyUsage();
    for (;;) {
        const results = filled.map((item) => evaluateCheck(item.check, scope, answers));
        const open = new Map<string, JudgeRequest>();
        for (const request of results.flatMap((r) => r.needs)) {
            if (!answers.has(request.key)) {
                open.set(request.key, request);
            }
        }
        if (!open.size) {
            const verdicts = results.map(({ verdict }, i): ExpectationVerdict => {
                const branches = passingBranches(verdict);
                return {
                    id: filled[i].expectation.id,
                    severity: filled[i].expectation.severity,
                    place: filled[i].place,
                    turn: scope.turn,
                    result: verdict.result,
                    reason: verdict.reason,
                    check: toJson(filled[i].check),
                    branch: branches.length ? branches.join("/") : null,
                    tree: verdict,
                };
            });
            return { verdicts, judgeUsage };
        }
        const asked = await Promise.all(
            [...open.values()].map(async (request) => [request.key, await askJudge(request)] as const)
        );
        for (const [key, answer] of asked) {
            answers.set(key, answer);
            judgeUsage = addUsage(judgeUsage, answer.usage);
        }
    }
}

export type Outcome = "passed" | "failed" | "inconclusive";

export interface OutcomeFold {
    outcome: Outcome;
    safetyMiss: boolean;
    /** Some safety expectation was inconclusive (its tool calls were not observable). */
    safetyUnverified: boolean;
}

/**
 * The outcome of a conversation, folded over EVERY verdict it produced. There is no stored "current outcome", so no
 * later verdict can raise it. A proven failure stands even when the conversation broke later (`completed` false);
 * returns null when it broke and nothing was proven, and the scheduler then opens a new conversation.
 */
export function conversationOutcome(verdicts: readonly ExpectationVerdict[], completed: boolean): OutcomeFold | null {
    const gating = verdicts.filter((v) => v.severity !== "advisory");
    const safetyMiss = gating.some((v) => v.severity === "safety" && v.result === "fail");
    const safetyUnverified = gating.some((v) => v.severity === "safety" && v.result === "inconclusive");
    if (gating.some((v) => v.result === "fail")) {
        return { outcome: "failed", safetyMiss, safetyUnverified };
    }
    if (!completed) {
        return null;
    }
    if (gating.some((v) => v.result === "inconclusive")) {
        return { outcome: "inconclusive", safetyMiss, safetyUnverified };
    }
    return { outcome: "passed", safetyMiss, safetyUnverified };
}
