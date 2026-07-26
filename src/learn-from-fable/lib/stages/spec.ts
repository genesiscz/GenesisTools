/**
 * Spec stage — turn mined principles into a FABLE-SPEC proposal.
 *
 * This closes the loop that used to require hand-seeding: mined principles are
 * merged INTO the current spec's structure so the skill can be regenerated from
 * mined data rather than from a file somebody wrote by hand.
 *
 * It reads BOTH consolidated principles (multi-model vote survivors, carrying a
 * confidence) and raw unconsolidated candidates, because the consolidation stage
 * is expensive and optional — the spec must be producible from whatever the miner
 * has actually collected. Candidates are fed in batches, each merging into the
 * running draft, so a corpus of any size is fully seen instead of silently
 * truncated by a context limit.
 *
 * Safety: this stage NEVER writes the canonical spec. It emits a proposal to a
 * separate path; promoting it is a human decision (review the diff, then copy).
 */
import { existsSync, readFileSync } from "node:fs";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import type { Runner } from "../runners";

/**
 * The size at which a bullet stops being a principle and starts being a pile.
 *
 * The hand-written spec this stage grew out of runs 229 characters per bullet with a
 * single 422-character outlier, so 420 is the shape the skill is generated from
 * rather than an arbitrary cap. Measured on the 2026-07-25 v6 proposal, the merge
 * passes had pushed the average to 736 and the worst bullet to 4_363 — the document
 * grew five-fold in bytes while staying inside a 220-LINE budget, because the only
 * move "MERGE, don't append" leaves open is gluing clauses onto existing bullets.
 */
const MAX_BULLET_CHARS = 420;

/**
 * What the tightening prompt asks for, below the hard cap on purpose.
 *
 * Measured on 2026-07-25 by replaying captured replies: told "under 420" the model
 * answered 435, 455, 430, 465 — right shape, a few characters over, and the whole
 * bullet was thrown away for it. Six of the sixteen rejects were this and nothing else.
 */
const TIGHTEN_TARGET_CHARS = 340;

export const SPEC_SYSTEM = `\
You maintain FABLE-SPEC.md: the distilled operating procedure of an expert coding \
agent ("Fable"), mined from real session transcripts. It is the single source of \
truth the fable-style skill is generated from.

You are given the CURRENT spec and a set of newly MINED PRINCIPLES (each with the \
session it came from; VETTED ones also carry a multi-model confidence, UNVETTED \
ones are raw extractor output). Produce the NEXT version of the spec.

Rules:
1. PRESERVE what is already there. Keep existing principles verbatim unless a \
mined principle proves one wrong or strictly subsumes it; then rewrite minimally \
and keep the original's citation.
2. MERGE, don't append. A mined principle that restates an existing one becomes a \
sharper wording or an extra clause on that bullet — never a duplicate bullet.
3. Keep the existing section structure; add a section only when several mined \
principles genuinely do not fit any of them.
4. Every bullet carries its WHY (imitate judgment, not ritual) and a citation \
suffix in the existing style, e.g. *(8a4faba3)*.
5. Prefer principles with high confidence and cross-session support. UNVETTED \
candidates have had no vote yet, so be stricter with them: most are task-specific \
trivia and should be dropped, not merged. Drop anything that is not transferable \
judgment.
6. GROWTH CONTROL: the spec must get sharper as it grows, not longer. Respect the \
line budget; if you are at the budget, merge or cut weaker bullets to make room.
7. NO EROSION. You are one pass in a sequence — the CURRENT SPEC already contains \
the merged result of every earlier batch. Your output must contain AT LEAST as many \
bullets as the CURRENT SPEC, and every existing section must survive. The only way a \
bullet count drops is if you genuinely folded two duplicates into one; "tightening" \
by deleting principles you were not given evidence against is a failure of this task.
8. BULLET SIZE. A bullet is ONE principle: at most two sentences plus its why and its \
citation, under ${MAX_BULLET_CHARS} characters. Merging does NOT mean gluing clauses \
onto an existing bullet until it becomes a paragraph. If a mined principle does not \
fit inside an existing bullet at that size, give it its OWN bullet or drop it. \
Rewriting an overlong bullet into a tighter one — or splitting it into two — is always \
allowed and never counts as erosion.

Output ONLY the complete markdown of the next spec. No prose about your changes, \
no code fences around the whole document.`;

/**
 * The tightening pass rewrites ONLY the oversized bullets, never the document.
 *
 * Asking for the whole document back is what killed the first version: handed a
 * 306-bullet, 95_000-character draft and told to split 44 bullets, the model returned
 * 178 bullets. Every principle outside the batch now survives by construction, because
 * the caller splices the replacements in and never touches the other lines.
 */
export const SPEC_TIGHTEN_SYSTEM = `\
You are editing single bullets from FABLE-SPEC.md, the distilled operating procedure \
of an expert coding agent. Each bullet you are given is a pile: several principles \
that earlier merge passes glued into one line.

For EACH numbered bullet, output the same content as one or two bullets (three only \
for the very longest). ${MAX_BULLET_CHARS} characters per bullet is a HARD limit that \
includes the leading "- " and the trailing *(citation)* — aim for about \
${TIGHTEN_TARGET_CHARS} so you have margin. A bullet one character over is discarded \
whole.

Rules:
1. TIGHTEN FIRST. The usual answer is ONE bullet saying the same thing in fewer words: \
same claim, same why, same citations. Split only when the bullet genuinely carries two \
independent principles that a reader would apply at different moments.
2. NEVER split a principle from its why. If two candidate pieces would end up repeating \
the SAME why, they are one principle and must stay one bullet. Fragments that share a \
why are the failure mode here — one input bullet becoming six near-identical bullets \
makes the document longer and less useful, not sharper.
3. LOSE NOTHING. Every claim and every *(citation)* in the input appears in your output. \
Cutting hedging, repetition and filler is not loss.
4. Keep the markdown style of the input exactly: leading "- ", bold lead-in, backticked \
commands, trailing *(citation)*.
5. Do not add principles, commentary, headings or numbering.

Output format: for each input bullet, a line "### <its number>" followed by the bullet \
lines that replace it. Nothing else.`;

/** A principle offered to the spec writer, vetted by consolidation or not. */
export interface SpecCandidate {
    sessionStem: string;
    minedBy: string;
    principle: string;
    why: string;
    /** Set only for candidates that survived consolidation. */
    finalConfidence?: number;
}

export interface SpecOptions {
    /** Hard line budget for the produced document. */
    maxLines: number;
    /** Only feed VETTED principles at or above this confidence (unvetted are unaffected). */
    minConfidence: number;
    /** Candidates per synthesis call; each batch merges into the running draft. */
    batchSize?: number;
    timeoutMs?: number;
    /** Silence budget before the first token; spec prompts reason for a long time. */
    firstOutputMs?: number;
    /** Final pass that splits oversized bullets back into principles. Default on. */
    tighten?: boolean;
}

export interface SpecResult {
    markdown: string;
    /** Candidates actually sent to the model. */
    principlesFed: number;
    vettedFed: number;
    unvettedFed: number;
    /** Synthesis calls made (one per batch). */
    batches: number;
    /** Passes discarded for eroding the draft; their candidates did not land. */
    rejectedPasses: number;
    beforeLines: number;
    afterLines: number;
    beforeBullets: number;
    afterBullets: number;
    /** Bullets still over the size cap — how far the result is from skill-ready. */
    beforeOverCap: number;
    afterOverCap: number;
    /** Whether the final tightening pass produced the document that was kept. */
    tightened: boolean;
}

/** Candidates per call. Sized so a batch's listing stays a few thousand tokens. */
const DEFAULT_BATCH_SIZE = 120;

/**
 * Erosion is measured on BOTH axes, each against its own HIGH-WATER MARK.
 *
 * Three earlier versions each failed differently, and all three failures are real:
 * - bullets vs the previous pass: rejected consolidation that legitimately produced
 *   fewer, longer bullets while GROWING the document;
 * - chars vs the previous pass: a slow leak, six passes each losing under 15% took
 *   90 bullets to 33 with nothing rejected (0.85^6 = 0.38);
 * - chars vs a high-water mark alone: the shape collapsed instead — a pass produced
 *   26 bullets holding 59_199 chars, folding whole sections into paragraph-blobs.
 *
 * Content protects against deletion, bullet count protects against blob-ification,
 * and high-water marks stop either from leaking away one tolerable step at a time.
 */
const MAX_CONTENT_LOSS = 0.15;
const MAX_BULLET_LOSS = 0.15;

/**
 * Token budget for a pass, sized from the document the budget actually allows.
 *
 * The output IS the whole spec, so a budget that does not fit `maxLines` bullets at
 * the size cap truncates the tail — which then reads as a lost section and gets the
 * pass discarded for erosion. The old `maxLines * 60` gave 13_200 tokens for a
 * document whose 5th pass already streamed ~15_600.
 */
function outputBudget(maxLines: number): number {
    const charsAllowed = maxLines * MAX_BULLET_CHARS;
    return Math.min(24_000, Math.max(8_000, Math.ceil(charsAllowed / 4)));
}

function isBullet(line: string): boolean {
    return /^\s*[-*]\s/.test(line);
}

function sectionsOf(markdown: string): string[] {
    return markdown
        .split("\n")
        .map((line) => line.match(/^##\s+(.*)$/)?.[1].trim())
        .filter((title): title is string => Boolean(title));
}

/** Citations are the identity of a principle: same source, same claim. */
function citationsOf(text: string): string[] {
    return [...text.matchAll(/\(([0-9a-f]{8})\)/g)].map((m) => m[1]);
}

function countBullets(markdown: string): number {
    return markdown.split("\n").filter(isBullet).length;
}

function bulletsOverCap(markdown: string): number {
    return markdown.split("\n").filter((line) => isBullet(line) && line.length > MAX_BULLET_CHARS).length;
}

/**
 * Past this length a bullet's extra characters are elaboration, not another principle.
 *
 * The erosion guard counts each bullet's substance as `min(length, this)`, which is
 * what lets the two guards coexist. Raw character count made them contradict each
 * other: bloat raised the high-water mark, and the pass that tightened those bullets
 * back to principle size then read as a 50% erosion and was discarded. It has to sit
 * BELOW the length a tightened principle lands at (the hand-written spec averages 229)
 * or trimming is still punished, and deleting a principle still registers in full
 * because the removed bullet takes its whole share with it.
 */
const SUBSTANCE_PER_BULLET = 200;

function effectiveContent(markdown: string): number {
    return markdown
        .split("\n")
        .reduce(
            (total, line) => total + (isBullet(line) ? Math.min(line.length, SUBSTANCE_PER_BULLET) : line.length),
            0
        );
}

export function buildSpecUser(
    existingSpec: string,
    principles: SpecCandidate[],
    maxLines: number,
    batchLabel?: string,
    correction?: string
): string {
    const listing = principles
        .map((p, i) => {
            const mark = p.finalConfidence === undefined ? "unvetted" : `${p.finalConfidence}% vetted`;
            return `${i + 1}. [${mark}] ${p.principle}\n   why: ${p.why}\n   source: session ${p.sessionStem.slice(0, 8)}, mined by ${p.minedBy}`;
        })
        .join("\n");

    const required = sectionsOf(existingSpec);

    return [
        ...(correction ? [`## CORRECTION\n${correction}`] : []),
        `## BUDGET\n${maxLines} lines maximum for the whole document, and ${MAX_BULLET_CHARS} characters maximum per bullet. A bullet at the cap does not get another clause — the principle either earns its own bullet or is dropped.`,
        // Naming them is worth the tokens: 8 of 13 passes in the 2026-07-25 v11 run were
        // discarded for deleting a section, and the run before it lost one for good.
        ...(required.length
            ? [
                  `## SECTIONS THAT MUST SURVIVE\nYour output must still contain every one of these "## " headings, spelled exactly:\n${required.map((s) => `- ## ${s}`).join("\n")}`,
              ]
            : []),
        `## CURRENT SPEC (${existingSpec.split("\n").length} lines)\n\n${existingSpec}`,
        `## MINED PRINCIPLES (${principles.length}${batchLabel ? `, ${batchLabel}` : ""})\n\n${listing}`,
    ].join("\n\n");
}

export function buildTightenUser(bullets: string[]): string {
    return bullets.map((text, i) => `### ${i + 1} (${text.length} chars)\n${text}`).join("\n\n");
}

/** Bullets per tightening call — small enough that the reply is never truncated. */
const TIGHTEN_BATCH = 6;

/** Tightening calls in flight. A 20-way probe of this proxy ran 15x faster than serial. */
const TIGHTEN_CONCURRENCY = 5;

/** How far over the cap a tightened bullet may land and still be an improvement worth keeping. */
const OVER_CAP_TOLERANCE = 1.25;

/**
 * Parse "### n" blocks back into replacement bullets, keyed by input index.
 * A block that comes back malformed is simply absent, so its original survives.
 */
export function parseTightenReply(reply: string): Map<number, string[]> {
    const replacements = new Map<number, string[]>();
    let current: number | undefined;

    for (const line of stripFence(reply).split("\n")) {
        const header = line.match(/^#{2,4}\s*(\d+)\b/);
        if (header) {
            current = Number(header[1]);
            replacements.set(current, []);
            continue;
        }

        if (current !== undefined && isBullet(line)) {
            replacements.get(current)?.push(line.trimEnd());
        }
    }

    return replacements;
}

/**
 * A replacement may change SHAPE, never content, and it may not multiply.
 *
 * Every citation has to reappear and the text has to stay substantial, or the reply is
 * a summary of what it dropped. It also may not GROW: the first version of this prompt
 * turned 44 piled bullets into 266 fragments that each repeated the same why, taking
 * the document from 306 bullets to 528 with 484 near-duplicate pairs. A bullet is
 * allowed about one piece per cap's worth of text, and no more total text than it
 * arrived with.
 */
function replacementRejection(original: string, replacement: string[]): string | undefined {
    if (!replacement.length) {
        return "empty";
    }

    const joined = replacement.join(" ");
    const maxPieces = Math.max(2, Math.ceil(original.length / MAX_BULLET_CHARS) + 1);
    const longest = Math.max(...replacement.map((line) => line.length));

    if (!citationsOf(original).every((c) => joined.includes(c))) {
        return "lost-citation";
    }

    if (joined.length < original.length * 0.6) {
        return "too-short";
    }

    if (joined.length > original.length * 1.2) {
        return "inflated";
    }

    if (replacement.length > maxPieces) {
        return "too-many-pieces";
    }

    // Overshooting the cap is not the same as failing. Of 51 replacements rejected for
    // this on 2026-07-25, EVERY ONE was shorter than the pile it replaced and 40 of
    // them missed by under 45 characters — 421 against a cap of 420. Take the
    // improvement when it is genuinely shorter and inside the tolerance band; the
    // second round re-attacks whatever is still over.
    if (longest >= original.length || longest > MAX_BULLET_CHARS * OVER_CAP_TOLERANCE) {
        return `still-over-cap (${longest})`;
    }

    return undefined;
}

/**
 * Rewrite only the bullets that are over the cap, splicing each replacement into the
 * document in place. Principle-sized bullets are never sent, never regenerated, and
 * therefore cannot be lost.
 *
 * Exported because it also repairs a proposal that was written before this existed,
 * without paying for the merge passes again.
 */
export async function tightenDraft(runner: Runner, draft: string, options: SpecOptions): Promise<string | undefined> {
    let current = draft;
    // A bullet that came back at 435 against a 420 cap was right in shape and lost on
    // length alone. Round two sees only what is still over, so a near miss costs one
    // small call rather than the principle.
    for (let round = 0; round < TIGHTEN_ROUNDS; round++) {
        const next = await tightenRound(runner, current, options, round);
        if (!next) {
            break;
        }

        current = next;
    }

    return current === draft ? undefined : current;
}

const TIGHTEN_ROUNDS = 2;

async function tightenRound(
    runner: Runner,
    draft: string,
    options: SpecOptions,
    round: number
): Promise<string | undefined> {
    const lines = draft.split("\n");
    // Round one targets every bullet over the real cap, so a 450-character bullet
    // gets its one attempt instead of silently staying over the limit the prompt
    // calls hard. Later rounds only chase what the pass would not accept back:
    // re-sending 437-character bullets and rejecting the tightened answers as
    // too-short was churn that could never converge on bullets already good enough.
    const threshold = round === 0 ? MAX_BULLET_CHARS : MAX_BULLET_CHARS * OVER_CAP_TOLERANCE;
    const targets = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => isBullet(line) && line.length > threshold);

    if (!targets.length) {
        return undefined;
    }

    const batches: (typeof targets)[] = [];
    for (let i = 0; i < targets.length; i += TIGHTEN_BATCH) {
        batches.push(targets.slice(i, i + TIGHTEN_BATCH));
    }

    // Unlike the merge passes, these batches are independent: each rewrites its own
    // bullets and the results are spliced back by line index, so nothing depends on
    // the order they finish in. Sequentially they cost minutes each, because a
    // reasoning model spends most of the call thinking.
    const replaced = new Map<number, string[]>();
    const replies = await concurrentMap({
        items: batches,
        concurrency: TIGHTEN_CONCURRENCY,
        fn: async (batch) => {
            const label = `spec-tighten-r${round + 1}-${batches.indexOf(batch) + 1}`;
            const reply = await runner.call({
                system: SPEC_TIGHTEN_SYSTEM,
                user: buildTightenUser(batch.map((t) => t.line)),
                maxTokens: 8000,
                timeoutMs: options.timeoutMs ?? 600_000,
                firstOutputMs: options.firstOutputMs ?? 300_000,
                label,
            });
            return { label, text: reply.text };
        },
        onError: (batch, error) =>
            logger.warn(
                { round: round + 1, bullets: batch.length, error },
                "spec tightening batch failed — those bullets stay as they are"
            ),
    });

    for (const [batch, reply] of replies) {
        for (const [n, bullets] of parseTightenReply(reply.text)) {
            const target = batch[n - 1];
            const rejection = target ? replacementRejection(target.line, bullets) : "no such input bullet";
            if (!target || rejection) {
                logger.debug(
                    { label: reply.label, n, reason: rejection, chars: target?.line.length, pieces: bullets.length },
                    "tightened bullet rejected — keeping the original"
                );
                continue;
            }

            replaced.set(target.index, bullets);
        }
    }

    if (!replaced.size) {
        logger.warn(
            { oversized: targets.length, round: round + 1 },
            "spec tightening changed nothing — keeping the merged draft"
        );
        return undefined;
    }

    const next = lines.flatMap((line, index) => replaced.get(index) ?? [line]).join("\n");
    logger.debug(
        {
            oversized: targets.length,
            rewritten: replaced.size,
            bulletsBefore: countBullets(draft),
            bulletsAfter: countBullets(next),
            overCapAfter: bulletsOverCap(next),
        },
        "spec draft tightened"
    );
    return next;
}

/**
 * Ask the model for the next spec, one batch of candidates at a time.
 * Returns the markdown; the caller decides where it lands.
 */
export async function synthesizeSpec(
    runner: Runner,
    existingSpecPath: string,
    principles: SpecCandidate[],
    options: SpecOptions
): Promise<SpecResult> {
    const existingSpec = existsSync(existingSpecPath) ? readFileSync(existingSpecPath, "utf-8") : "";
    const eligible = principles
        .filter((p) => p.finalConfidence === undefined || p.finalConfidence >= options.minConfidence)
        // vetted first, strongest first — the draft is shaped by the best evidence
        // before raw candidates get their chance to sharpen it
        .sort((a, b) => (b.finalConfidence ?? -1) - (a.finalConfidence ?? -1));

    if (!eligible.length) {
        throw new Error("no principle candidates to feed the spec");
    }

    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const batches: SpecCandidate[][] = [];
    for (let i = 0; i < eligible.length; i += batchSize) {
        batches.push(eligible.slice(i, i + batchSize));
    }

    let draft = existingSpec;
    let rejected = 0;
    /** Largest draft seen; every pass is judged against this, never against its predecessor. */
    let highWater = effectiveContent(existingSpec);
    let highWaterBullets = countBullets(existingSpec);
    let highWaterSections = sectionsOf(existingSpec);

    /** Why the last attempt was discarded, so the retry is told the actual reason. */
    let lastFailure = "it threw away most of the document or produced nothing";

    /** One merge attempt. Returns the next draft, or undefined if it must be discarded. */
    const attempt = async (
        batch: SpecCandidate[],
        label: string,
        callLabel: string,
        correction?: string
    ): Promise<string | undefined> => {
        let reply: Awaited<ReturnType<Runner["call"]>>;
        try {
            reply = await runner.call({
                system: SPEC_SYSTEM,
                user: buildSpecUser(draft, batch, options.maxLines, label, correction),
                // the spec is the output, so the budget must fit the whole document
                maxTokens: outputBudget(options.maxLines),
                timeoutMs: options.timeoutMs ?? 600_000,
                // A spec pass hands the model the whole current document plus hundreds
                // of candidates and asks for a full rewrite, so it reasons far longer
                // before the first token than the small graded calls the default budget
                // was measured on. 90s killed pass 4 of 6 and took three merged passes
                // down with it.
                firstOutputMs: options.firstOutputMs ?? 300_000,
                label: callLabel,
            });
        } catch (err) {
            logger.warn({ batch: label, error: err }, "spec pass failed");
            return undefined;
        }

        const next = stripFence(reply.text).trim();
        if (!next) {
            lastFailure = "you produced nothing at all";
            logger.warn({ batch: label }, "spec synthesis returned empty text");
            return undefined;
        }

        const bullets = countBullets(next);
        const content = effectiveContent(next);
        const lostContent = highWater > 0 && content < highWater * (1 - MAX_CONTENT_LOSS);
        const lostStructure = highWaterBullets > 0 && bullets < highWaterBullets * (1 - MAX_BULLET_LOSS);
        // A whole section can vanish while the bullet count still GROWS, which is how
        // the 2026-07-25 v9 run silently dropped "Judgment calls (when to ask vs
        // proceed)" — eight principles about the hardest call there is — from a
        // proposal that looked healthy on both other axes.
        const missing = highWaterSections.filter((title) => !sectionsOf(next).includes(title));
        if (lostContent || lostStructure || missing.length) {
            lastFailure = missing.length
                ? `you deleted ${missing.length} whole section(s): ${missing.map((s) => `"${s}"`).join(", ")}`
                : lostContent
                  ? "you deleted most of the document's content"
                  : `you returned ${bullets} bullets where the document had ${highWaterBullets}`;
            logger.warn(
                {
                    batch: label,
                    reason: missing.length ? "sections" : lostContent ? "content" : "structure",
                    highWaterChars: highWater,
                    charsAfter: content,
                    highWaterBullets,
                    bulletsAfter: bullets,
                    missingSections: missing,
                },
                "spec pass eroded the draft"
            );
            return undefined;
        }

        return next;
    };

    for (const [index, batch] of batches.entries()) {
        const label = `batch ${index + 1}/${batches.length}`;
        const callLabel = `spec-${index + 1}of${batches.length}-${batch.length}p`;
        let next = await attempt(batch, label, callLabel);

        if (!next) {
            // Retry ONCE with the failure named. A discarded pass means this batch's
            // candidates never reach the spec at all, and the whole point of the stage
            // is that every mined candidate gets considered — so it is worth one more
            // call, told exactly what went wrong the first time.
            next = await attempt(
                batch,
                `${label} retry`,
                `${callLabel}-retry`,
                `Your previous attempt at this batch was DISCARDED because ${lastFailure}. ` +
                    `Carry every principle and every "## " heading of the CURRENT SPEC forward and fold this batch into them; the result must keep all ${highWaterSections.length} sections and at least ${highWaterBullets} bullets, as a bulleted list rather than sections folded into single long paragraphs.`
            );
        }

        if (!next) {
            rejected++;
            logger.warn({ batch: label }, "spec pass discarded after retry — keeping the previous draft");
            continue;
        }

        draft = next;
        highWater = Math.max(highWater, effectiveContent(draft));
        highWaterBullets = Math.max(highWaterBullets, countBullets(draft));
        // a section the model legitimately ADDED is protected from here on too
        highWaterSections = [...new Set([...highWaterSections, ...sectionsOf(draft)])];
        logger.debug(
            {
                batch: label,
                lines: draft.split("\n").length,
                bullets: countBullets(draft),
                chars: draft.length,
                overCap: bulletsOverCap(draft),
            },
            "spec draft merged a batch"
        );
    }

    if (!draft.trim()) {
        throw new Error("spec synthesis returned empty text");
    }

    // Every pass discarded means the draft is still the input document — writing it
    // out as a "proposal" is a false green. It happened on 2026-07-25 when the Grok
    // session token expired: 15 passes failed in the same second with a 502 and the
    // stage cheerfully produced a byte-for-byte copy of the canonical spec.
    if (rejected === batches.length) {
        throw new Error(
            `every one of the ${batches.length} merge passes was discarded — the proposal would be an unchanged copy of the current spec; check the log for the per-pass reason`
        );
    }

    let tightened = false;
    if (options.tighten !== false) {
        const next = await tightenDraft(runner, draft, options);
        if (next) {
            draft = next;
            tightened = true;
        }
    }

    const result: SpecResult = {
        markdown: `${draft.trim()}\n`,
        principlesFed: eligible.length,
        vettedFed: eligible.filter((p) => p.finalConfidence !== undefined).length,
        unvettedFed: eligible.filter((p) => p.finalConfidence === undefined).length,
        batches: batches.length,
        rejectedPasses: rejected,
        beforeLines: existingSpec.split("\n").length,
        afterLines: draft.trim().split("\n").length,
        beforeBullets: countBullets(existingSpec),
        afterBullets: countBullets(draft),
        beforeOverCap: bulletsOverCap(existingSpec),
        afterOverCap: bulletsOverCap(draft),
        tightened,
    };

    if (result.afterLines > options.maxLines) {
        logger.warn(
            { budget: options.maxLines, produced: result.afterLines },
            "spec synthesis exceeded the line budget"
        );
    }

    return result;
}

/** Models sometimes wrap the whole document in a fence despite instructions. */
function stripFence(text: string): string {
    const fenced = text.match(/^\s*```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/);
    return fenced ? fenced[1] : text;
}
