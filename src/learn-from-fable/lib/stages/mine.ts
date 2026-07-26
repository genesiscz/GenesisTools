/**
 * Mine stage — decision-point episode + principle-candidate extraction.
 * Distilled from SkillOpt's mine_fable_episodes.py: the extractor model only
 * picks WHICH turns are decision points; episode assembly (prefix, reference,
 * outcome) is deterministic TS from lib/transcript. Results are crash-safe
 * (appended per session as mined) and kept PER MODEL so multiple miners can
 * run over the same corpus without clobbering each other.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { pipeline } from "@genesiscz/utils/pipeline";
import { ensureMetaDirs, type FableConfig, packPaths, STAGE_CONCURRENCY } from "../config";
import type { Runner } from "../runners";
import {
    buildPrefix,
    condenseForExtraction,
    loadTurns,
    referenceGist,
    referenceOutcome,
    type Turn,
} from "../transcript";
import { type Episode, type PrincipleCandidate, TASK_TYPES } from "./types";

export const EXTRACT_SYSTEM = `\
You find DECISION POINTS in an expert agent's ("Fable") transcript: moments where \
Fable's NEXT move (a) exercises one of the given FABLE-SPEC principles AND (b) a \
competent-but-generic agent would plausibly have done something lazier (claimed \
done, edited without grepping, accepted the premise, slept unbounded, guessed). \
When no spec is provided, judge principle-worthiness yourself.

You are given numbered turns (#idx). Pick 1-4 of the strongest decision points. \
For each, name the FABLE assistant turn index whose move should be cloned (it must \
be a turn marked "(fable)"), the task_type, and 0-3 FABLE-SPEC principles it \
exercises (copy each principle sentence VERBATIM from the spec when one applies).

ALSO extract 0-3 PRINCIPLE CANDIDATES: generalizable working habits this window \
demonstrates, each with its why. Only habits that reflect judgment; skip \
task-specific trivia.

Output ONLY strict JSON:
{"decisions": [{"turn": <int #idx of the fable move>, "task_type": "<planning|\
command-style|verification|reporting|recovery|judgment>", "spec_axes": [{"id": \
"<short-slug>", "text": "<verbatim principle from the spec>"}], "reason": "<what \
a generic agent would have done instead, 1 sentence>"}], "principles": [{"text": \
"<the habit>", "why": "<why it matters, grounded in what you saw>", "turn": <int|null>}]}
No prose outside the JSON.`;

export const EXTRACT_SCHEMA = {
    name: "fable_mine_window",
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["decisions", "principles"],
        properties: {
            decisions: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["turn", "task_type", "spec_axes", "reason"],
                    properties: {
                        turn: { type: "integer" },
                        task_type: { type: "string" },
                        spec_axes: {
                            type: "array",
                            items: {
                                type: "object",
                                additionalProperties: false,
                                properties: { id: { type: "string" }, text: { type: "string" } },
                            },
                        },
                        reason: { type: "string" },
                    },
                },
            },
            principles: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["text", "why"],
                    properties: {
                        text: { type: "string" },
                        why: { type: "string" },
                        turn: { type: ["integer", "null"] },
                    },
                },
            },
        },
    },
};

/**
 * Hedging is OFF by default: measured 2026-07-24 on grok-4.5, four hedges fired
 * at 25s and the two that won saved 2.8s and 4.0s, while the straggler that set
 * the run's wall time (48.0s) got a SLOWER second attempt (69.0s). The latency
 * is upstream queueing, not per-connection variance, so a duplicate joins the
 * same queue. Opt in with --hedge-after when a provider's tail is connection-bound.
 */
const DEFAULT_HEDGE_MS = 0;

/** Bump when prefix/reference rendering changes (see Episode.parserVersion). */
export const EPISODE_PARSER_VERSION = 2;

export function modelSlug(runnerId: string): string {
    return runnerId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export interface MineSessionOptions {
    maxPerSession: number;
    maxWindows: number;
    timeoutMs?: number;
    /** Extractor calls in flight at once (default STAGE_CONCURRENCY). */
    concurrency?: number;
    /** Re-issue a window whose call outlives this (tail-latency hedge); 0 disables. */
    hedgeAfterMs?: number;
    /** Parse + windows only; no model calls (the pre-mine stage). */
    dry?: boolean;
}

export interface MineSessionResult {
    session: string;
    stem: string;
    runId: string;
    turns: number;
    fableTurns: number;
    windows: number;
    windowsSampled: number;
    episodes: Episode[];
    principles: PrincipleCandidate[];
    extractorFailures: number;
    secs: number;
}

interface ExtractorPick {
    turn?: unknown;
    task_type?: unknown;
    spec_axes?: { id?: string; text?: string }[];
    reason?: unknown;
}

/** Sample windows EVENLY across the session (not first-N) — decisions happen throughout. */
export function sampleEvenly<T>(items: T[], max: number): T[] {
    if (items.length <= max) {
        return items;
    }

    const step = items.length / max;
    return Array.from({ length: max }, (_, i) => items[Math.min(Math.floor(i * step), items.length - 1)]);
}

export async function mineSession(
    config: FableConfig,
    runner: Runner | undefined,
    runId: string,
    sessionPath: string,
    options: MineSessionOptions
): Promise<MineSessionResult> {
    const started = performance.now();
    const stem = basename(sessionPath).replace(/\.jsonl$/, "");
    const paths = packPaths(config);
    const spec = existsSync(paths.spec) ? readFileSync(paths.spec, "utf-8") : "";

    const turns = await loadTurns(sessionPath);
    const allWindows = condenseForExtraction(turns);
    const windows = sampleEvenly(allWindows, options.maxWindows);
    const result: MineSessionResult = {
        session: sessionPath,
        stem,
        runId,
        turns: turns.length,
        fableTurns: turns.filter((t) => t.role === "assistant" && t.isFable).length,
        windows: allWindows.length,
        windowsSampled: windows.length,
        episodes: [],
        principles: [],
        extractorFailures: 0,
        secs: 0,
    };

    if (options.dry || !runner) {
        result.secs = (performance.now() - started) / 1000;
        return result;
    }

    const picks: ExtractorPick[] = [];
    const extractWindow = async ([i, win]: [number, string]) => {
        const user = `## FABLE-SPEC principles\n${spec || "(no spec yet — bootstrap run)"}\n\n## Transcript turns\n${win}`;
        try {
            const reply = await runner.call({
                system: EXTRACT_SYSTEM,
                user,
                maxTokens: 3000,
                timeoutMs: options.timeoutMs ?? 300_000,
                jsonSchema: EXTRACT_SCHEMA,
                label: `extract-window-${i}-${stem.slice(0, 8)}`,
            });
            const parsed = reply.parsed as
                | { decisions?: ExtractorPick[]; principles?: { text?: string; why?: string; turn?: number | null }[] }
                | undefined;

            if (!parsed || typeof parsed !== "object") {
                result.extractorFailures++;
                logger.warn(
                    { stem, window: i, parseError: reply.parseError, raw: reply.text.slice(0, 200) },
                    "JSON-DRIFT extractor window dropped"
                );
                return;
            }

            picks.push(...(parsed.decisions ?? []));
            for (const p of parsed.principles ?? []) {
                if (p?.text && p.why) {
                    result.principles.push({
                        sessionStem: stem,
                        minedBy: runner.id,
                        runId,
                        principle: String(p.text),
                        why: String(p.why),
                        turn: typeof p.turn === "number" ? p.turn : undefined,
                    });
                }
            }
        } catch (err) {
            result.extractorFailures++;
            logger.warn({ stem, window: i, error: err }, "extractor call failed for window");
        }
    };

    // Windows are independent — the proxy fans them out (20 concurrent grok calls
    // measured at 15x the serial time), so only bound the fan-out, don't serialize.
    await pipeline([...windows.entries()] as [number, string][], { scope: "lff-mine" })
        .map("extract-window", extractWindow, {
            concurrency: options.concurrency ?? STAGE_CONCURRENCY,
            hedgeAfterMs: (options.hedgeAfterMs ?? DEFAULT_HEDGE_MS) || undefined,
            onHedge: (item) =>
                logger.info(
                    { stem, window: (item as [number, string])[0] },
                    "extractor straggler — hedging a second attempt"
                ),
        })
        .drain();

    result.episodes = assembleEpisodes(turns, picks, stem, sessionPath, runner.id, runId, options.maxPerSession);
    result.secs = (performance.now() - started) / 1000;
    return result;
}

function assembleEpisodes(
    turns: Turn[],
    picks: ExtractorPick[],
    stem: string,
    sessionPath: string,
    minedBy: string,
    runId: string,
    maxPerSession: number
): Episode[] {
    const episodes: Episode[] = [];
    for (const pick of picks) {
        const idx = Number(pick.turn);
        if (!Number.isInteger(idx) || idx < 0 || idx >= turns.length) {
            continue;
        }

        const turn = turns[idx];
        // reference MUST be a real, TOP-LEVEL Fable turn (no subagents/sidechains)
        if (turn.role !== "assistant" || !turn.isFable || turn.isSidechain) {
            continue;
        }

        const ref = referenceGist(turn);
        if (!ref.trim()) {
            continue;
        }

        const taskType = String(pick.task_type ?? "judgment");
        episodes.push({
            id: `${stem}-t${idx}`,
            sourceSession: sessionPath,
            taskType: (TASK_TYPES as readonly string[]).includes(taskType) ? taskType : "judgment",
            contextPrefix: buildPrefix(turns, idx),
            referenceAction: ref,
            referenceOutcome: referenceOutcome(turns, idx),
            specAxes: Array.isArray(pick.spec_axes) ? pick.spec_axes : [],
            minedBy,
            parserVersion: EPISODE_PARSER_VERSION,
            runId,
        });
    }

    // de-dup by id, prefer episodes with more spec axes, cap per session
    const seen = new Set<string>();
    const unique: Episode[] = [];
    for (const ep of [...episodes].sort((a, b) => b.specAxes.length - a.specAxes.length)) {
        if (seen.has(ep.id)) {
            continue;
        }

        seen.add(ep.id);
        unique.push(ep);
    }

    return unique.slice(0, maxPerSession);
}

export interface MineManifestRow {
    session: string;
    stem: string;
    model: string;
    runId: string;
    minedAt: string;
    episodes: number;
    principles: number;
    extractorFailures: number;
    secs: number;
}

/** Crash-safe persistence: raw episodes + principles + manifest line, appended per session as mined. */
/** Scores are produced by the filter stage; a re-mine must not wipe them. */
function pickScores(ep: Episode): Partial<Episode> {
    const scores: Partial<Episode> = {};
    if (ep.naiveScore !== undefined) {
        scores.naiveScore = ep.naiveScore;
    }

    if (ep.referenceScore !== undefined) {
        scores.referenceScore = ep.referenceScore;
    }

    if (ep.naiveReply !== undefined) {
        scores.naiveReply = ep.naiveReply;
    }

    return scores;
}

/** Identity of a principle candidate: same text, same session, same miner. */
function principleKey(p: PrincipleCandidate): string {
    return `${p.sessionStem}|${p.minedBy}|${p.principle.trim().toLowerCase()}`;
}

/**
 * "No episodes" is only a verdict on the session when most of its windows were
 * actually read. Recording an outage as mined retires the session forever — the
 * proxy crashed mid-run on 2026-07-25 and 83 sessions were marked done with zero
 * episodes, which had to be unpicked by hand — while re-mining one costs only
 * calls. The cost is that asymmetric, so ties go to retrying: a session is
 * withheld once failures reach half its sampled windows.
 *
 * The bound matters in both directions. A single flaky window among many good
 * ones is not an outage, and must not keep a genuinely empty session in the
 * queue forever; a lone success among mostly-failed windows is not evidence the
 * session is empty, and must not retire it.
 */
export function isExtractionOutage(result: MineSessionResult): boolean {
    if (result.episodes.length || !result.windowsSampled) {
        return false;
    }

    return result.extractorFailures * 2 >= result.windowsSampled;
}

export function persistSessionResult(config: FableConfig, runner: Runner, result: MineSessionResult): void {
    const paths = ensureMetaDirs(config);
    const slug = modelSlug(runner.id);

    // Episode ids are deterministic (session stem + turn index), so re-mining a
    // session yields the SAME ids. Merge by id instead of appending, otherwise a
    // second mine run silently doubles the corpus and every downstream stage pays
    // to judge the same episode twice (observed: one episode present 5x).
    const episodesPath = join(paths.episodesDir, `episodes.${slug}.raw.jsonl`);
    const byId = new Map<string, Episode>();
    if (existsSync(episodesPath)) {
        for (const line of readFileSync(episodesPath, "utf-8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const existing: Episode = SafeJSON.parse(line, { strict: true });
                byId.set(existing.id, existing);
            } catch (err) {
                logger.debug({ error: err }, "bad raw episode line skipped");
            }
        }
    }

    const before = byId.size;
    for (const ep of result.episodes) {
        // keep the filter's scores if this episode was already assessed
        const prior = byId.get(ep.id);
        byId.set(ep.id, prior ? { ...ep, ...pickScores(prior) } : ep);
    }

    writeFileSync(
        episodesPath,
        `${[...byId.values()].map((ep) => SafeJSON.stringify(ep, { strict: true })).join("\n")}\n`
    );
    logger.debug(
        { slug, before, after: byId.size, mined: result.episodes.length },
        "episodes merged by id (re-mine is idempotent)"
    );

    const principlesPath = join(paths.principlesDir, "unconsolidated.jsonl");
    const seenPrinciples = new Set<string>();
    if (existsSync(principlesPath)) {
        for (const line of readFileSync(principlesPath, "utf-8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const existing: PrincipleCandidate = SafeJSON.parse(line, { strict: true });
                seenPrinciples.add(principleKey(existing));
            } catch (err) {
                logger.debug({ error: err }, "bad principle line skipped");
            }
        }
    }

    for (const p of result.principles) {
        if (seenPrinciples.has(principleKey(p))) {
            continue; // same habit, same session, same miner — already recorded
        }

        seenPrinciples.add(principleKey(p));
        appendFileSync(principlesPath, `${SafeJSON.stringify(p, { strict: true })}\n`);
    }

    const row: MineManifestRow = {
        session: result.session,
        stem: result.stem,
        model: runner.id,
        runId: result.runId,
        minedAt: new Date().toISOString(),
        episodes: result.episodes.length,
        principles: result.principles.length,
        extractorFailures: result.extractorFailures,
        secs: Math.round(result.secs * 10) / 10,
    };

    // A genuinely empty session (no failures, no decision points) still gets
    // recorded; see isExtractionOutage for where the line sits and why.
    if (isExtractionOutage(result)) {
        logger.warn(
            { stem: result.stem, windows: result.windowsSampled, failures: result.extractorFailures },
            "session produced no episodes and too many windows failed to call it empty — NOT marking it mined"
        );
        return;
    }

    appendFileSync(join(paths.metaDir, "mined.jsonl"), `${SafeJSON.stringify(row, { strict: true })}\n`);
    out.log.info(
        `${result.stem.slice(0, 8)}: ${result.episodes.length} episodes, ${result.principles.length} principles (${row.secs}s)`
    );
}

/** Stems already mined by a given model (or any model when model is undefined). */
export function minedStemsForModel(config: FableConfig, model?: string): Set<string> {
    const paths = packPaths(config);
    const manifest = join(paths.metaDir, "mined.jsonl");
    const stems = new Set<string>();
    if (!existsSync(manifest)) {
        return stems;
    }

    for (const line of readFileSync(manifest, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const row: MineManifestRow = SafeJSON.parse(line, { strict: true });
            if (!model || row.model === model) {
                stems.add(row.stem);
            }
        } catch (err) {
            logger.debug({ error: err }, "bad mined.jsonl line skipped");
        }
    }

    return stems;
}

/** Load raw episodes for a model slug (or all models). */
/**
 * Load mined episodes. The filter stage writes its scores to the `.filtered`
 * files, so those are read too and win on conflict — otherwise a scored episode
 * looks unscored to later stages (eval --filtered-only found nothing).
 */
export function loadEpisodes(config: FableConfig, slug?: string): Episode[] {
    const paths = ensureMetaDirs(config);
    const patterns = slug
        ? [`episodes.${slug}.raw.jsonl`, `episodes.${slug}.filtered.jsonl`]
        : ["episodes.*.raw.jsonl", "episodes.*.filtered.jsonl"];
    const byId = new Map<string, Episode>();

    const files = patterns.flatMap((pattern) => [
        ...new Bun.Glob(pattern).scanSync({ cwd: paths.episodesDir, absolute: true }),
    ]);

    for (const file of files) {
        for (const line of readFileSync(file, "utf-8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const ep: Episode = SafeJSON.parse(line, { strict: true });
                byId.set(`${ep.minedBy}:${ep.id}`, ep);
            } catch (err) {
                logger.debug({ file, error: err }, "bad episode line skipped");
            }
        }
    }

    return [...byId.values()];
}
