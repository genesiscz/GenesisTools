/**
 * Judge rubric — ported from SkillOpt fable_clone judge_prompt.py (the §A.1
 * rubric). Grades a candidate "what do you do next" reply at a mined decision
 * point against (a) Fable's actual next move and (b) the spec principles that
 * point exercises. Deliberately anchored to the reference and hostile to
 * spec-flavored boilerplate. Powers the contrastive filter and the A/B eval.
 */
import { extractJsonValue } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { logger } from "@genesiscz/utils/logger";
import type { Runner } from "../runners";
import type { Episode } from "./types";

const W_A1 = 0.35;
const W_A2 = 0.25;
const W_A3 = 0.25;
const W_A4 = 0.15;

export const JUDGE_SYSTEM = `\
You are a strict, calibrated grader of AGENT JUDGMENT. You are given decision \
points taken from real transcripts of an expert agent ("Fable"). At each point \
you see the situation, a CANDIDATE's proposed next move, the REFERENCE (what \
Fable actually did next), and the FABLE-SPEC principles that moment exercises. \
Score how Fable-like the candidate's move is on four axes.

Grade each item INDEPENDENTLY. Do not let one item's score anchor another.

AXES (score each per item):
- a1 ACTION-CLASS MATCH {0, 0.5, 1}: Is the candidate's next move the same CLASS \
of move as the reference (verify / probe-premise / measure-blast-radius / \
hold-and-ask / background-with-bounded-wait / reconcile-discrepancy / ...)? \
1 = same class. 0.5 = a different class that is still defensibly Fable-equivalent \
under the listed principles. 0 = a lazier/different move (claimed done, edited \
without checking, accepted the premise, slept unbounded, guessed).
- a2 EVIDENCE EQUIVALENCE {0, 0.5, 1}: Would EXECUTING the candidate's stated \
action(s) produce the same DECISIVE evidence the reference produced (the log line, \
exit code, ancestor check, owner PID, diff count)? 1 = yes. 0.5 = partial/weaker \
evidence. 0 = would not produce the decisive evidence.
- a3 SPEC CONFORMANCE {0..1}: Fraction (k/n) of THIS item's listed spec principles \
the candidate satisfies. Judge each principle yes/no, report the fraction. When no \
principles are listed, score 1.
- a4 GROUNDED SPECIFICITY (anti-ritual) {0, 0.5, 1}: 1 = cites concrete \
paths/commands/symbols FROM THIS SITUATION. 0.5 = generic-but-plausible commands. \
0 = spec-sounding boilerplate with no executable content.

ANTI-GAMING (binding): reward ONLY replies whose actions are executable against \
THIS situation. A reply that restates verification principles ("I should verify \
first", "let me check the premise") WITHOUT naming the concrete command / file / \
check scores a4 = 0 and CANNOT score a1 = 1.

OUTPUT: a strict JSON array, one object per item, in the SAME ORDER as given:
[{"id": "<id>", "a1": <0|0.5|1>, "a2": <0|0.5|1>, "a3": <0..1>, "a4": <0|0.5|1>, \
"verdict": "<=15 words"}]
Output ONLY the JSON array. No prose before or after.`;

export interface JudgeVerdict {
    a1: number;
    a2: number;
    a3: number;
    a4: number;
    hard: 0 | 1;
    soft: number;
    verdict: string;
}

export function scoreFromAxes(a1: number, a2: number, a3: number, a4: number): { hard: 0 | 1; soft: number } {
    const clamp = (v: number) => Math.max(0, Math.min(1, Number(v)));
    const c1 = clamp(a1);
    const c2 = clamp(a2);
    const c3 = clamp(a3);
    const c4 = clamp(a4);
    const soft = Math.round((W_A1 * c1 + W_A2 * c2 + W_A3 * c3 + W_A4 * c4) * 10_000) / 10_000;
    return { hard: c1 === 1 && soft >= 0.7 ? 1 : 0, soft };
}

function formatAxes(axes: Episode["specAxes"]): string {
    const lines = (axes ?? []).map((ax) => `  - [${ax.id ?? "?"}] ${ax.text ?? ""}`);
    return lines.join("\n") || "  - (none)";
}

export interface JudgeItem {
    episode: Episode;
    candidate: string;
}

export function buildJudgeUser(batch: JudgeItem[]): string {
    const blocks = batch.map(
        ({ episode, candidate }) => `### ITEM ${episode.id}
SITUATION (transcript prefix up to the decision point):
${episode.contextPrefix.trim()}

CANDIDATE next move:
${candidate.trim() || "(empty)"}

REFERENCE (what Fable actually did next):
${episode.referenceAction.trim()}
REFERENCE outcome: ${episode.referenceOutcome.trim()}

FABLE-SPEC principles this point exercises:
${formatAxes(episode.specAxes)}`
    );

    return `Grade the following ${batch.length} item(s). Return the JSON array only.\n\n${blocks.join("\n\n")}`;
}

interface RawJudgeRow {
    id?: unknown;
    a1?: unknown;
    a2?: unknown;
    a3?: unknown;
    a4?: unknown;
    verdict?: unknown;
}

export function parseJudgeArray(text: string): Map<string, JudgeVerdict> {
    const out = new Map<string, JudgeVerdict>();
    const { value } = extractJsonValue(text);
    // A one-item batch gets answered with a bare object, not a one-element array
    // — which the degrade path made WORSE, since drift shrinks the batch toward 1
    // (observed 2026-07-25: opus-5 returned a perfectly good verdict object at
    // size 1 and the episode was still recorded as given-up).
    const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];

    for (const row of rows as RawJudgeRow[]) {
        if (!row || typeof row !== "object" || row.id === undefined) {
            continue;
        }

        const a1 = Number(row.a1);
        const a2 = Number(row.a2);
        const a3 = Number(row.a3);
        const a4 = Number(row.a4);
        if ([a1, a2, a3, a4].some(Number.isNaN)) {
            continue;
        }

        const { hard, soft } = scoreFromAxes(a1, a2, a3, a4);
        out.set(String(row.id), { a1, a2, a3, a4, hard, soft, verdict: String(row.verdict ?? "").slice(0, 200) });
    }

    return out;
}

/** Attempts spent on a single-item batch before the episode is given up on. */
const SINGLE_ITEM_ATTEMPTS = 2;

async function judgeChunk(
    runner: Runner,
    items: JudgeItem[],
    timeoutMs: number,
    into: Map<string, JudgeVerdict>
): Promise<void> {
    if (!items.length) {
        return;
    }

    const wanted = new Set(items.map((it) => it.episode.id));
    const attempts = items.length === 1 ? SINGLE_ITEM_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await runner.call({
                system: JUDGE_SYSTEM,
                user: buildJudgeUser(items),
                maxTokens: 1200 + 220 * items.length,
                timeoutMs,
                label: `judge-${items.length}x-${items[0]?.episode.id.slice(-4) ?? "batch"}`,
            });
            for (const [id, verdict] of parseJudgeArray(response.text)) {
                if (wanted.has(id) && !into.has(id)) {
                    into.set(id, verdict);
                }
            }
        } catch (err) {
            logger.warn({ error: err, size: items.length, runner: runner.id }, "judge call failed");
        }

        if (items.every((it) => into.has(it.episode.id))) {
            return;
        }
    }

    const missing = items.filter((it) => !into.has(it.episode.id));
    if (items.length === 1) {
        logger.warn(
            { id: items[0]?.episode.id, runner: runner.id },
            "JSON-DRIFT judge gave up on episode at batch size 1"
        );
        return;
    }

    // Degrade: halve the batch size and re-judge only what is still missing.
    const nextSize = Math.ceil(items.length / 2);
    logger.warn(
        { got: items.length - missing.length, want: items.length, nextSize, runner: runner.id },
        "JSON-DRIFT judge batch short; degrading batch size"
    );
    for (let i = 0; i < missing.length; i += nextSize) {
        await judgeChunk(runner, missing.slice(i, i + nextSize), timeoutMs, into);
    }
}

/**
 * Judge a batch of candidates. On a short/unparseable array (JSON drift) the
 * batch size is halved down to 1 and only the missing items are re-judged, so a
 * single drifting response never drops the whole batch.
 */
export async function judgeBatch(
    runner: Runner,
    batch: JudgeItem[],
    timeoutMs = 300_000
): Promise<Map<string, JudgeVerdict>> {
    const verdicts = new Map<string, JudgeVerdict>();
    await judgeChunk(runner, batch, timeoutMs, verdicts);
    return verdicts;
}
