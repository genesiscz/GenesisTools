import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { similarityScore } from "@genesiscz/utils/fuzzy-match";
import { SafeJSON } from "@genesiscz/utils/json";
import type { TranscriptEntry } from "./types";

/**
 * Finds words a speech recognizer probably misheard, by comparing every 1 to 3 word run of the
 * transcript with a vocabulary of terms that should appear instead.
 *
 * Scoring: edit distance on the raw text, on a phonetic key, and on the key's consonant skeleton, mixed
 * into one confidence. The phonetic key is tuned for Czech speakers saying English jargon, which
 * no published phonetic algorithm covers.
 */

export interface VocabTerm {
    term: string;
    source: string;
}

export interface TermCandidate {
    term: string;
    /** 0 to 100. */
    confidence: number;
    source: string;
}

export interface TermSuggestion {
    heard: string;
    occurrences: number;
    /** `stem`: the heard word is an inflected form (Czech case ending), so a plain swap would break grammar. */
    kind: "exact" | "stem";
    candidates: TermCandidate[];
}

export const DEFAULT_MIN_CONFIDENCE = 70;
const MAX_CANDIDATES = 3;
const CONTEXT_BONUS = 0.05;
const STEM_PENALTY = 0.92;
const MIN_KEY_LENGTH = 4;
/** A term this short matches too many ordinary words, so it must match almost exactly. */
const SHORT_KEY = 4;
const SHORT_KEY_MIN = 0.9;
/** A longer run replaces a shorter one only when it scores clearly better. */
const LONGER_RUN_MARGIN = 3;
/** A term followed by at most this many letters is the term with a Czech case ending, not a mishearing. */
const MAX_ENDING = 3;
/** Czech verb endings ("-ovat") are longer, so a phonetic prefix match allows one more letter. */
const MAX_SOUND_ENDING = 4;
/** Candidates shown under a suspect whose best match passed the threshold may sit this far below it. */
const CANDIDATE_SPREAD = 20;
const ENGLISH_WORDS_PATH = "/usr/share/dict/words";
let englishWords: Set<string> | undefined;

/** A real English word ("reject", "transcript") is what the speaker said, not a mishearing. */
function isEnglishWord(word: string): boolean {
    if (!englishWords) {
        englishWords = existsSync(ENGLISH_WORDS_PATH)
            ? new Set(readFileSync(ENGLISH_WORDS_PATH, "utf8").toLowerCase().split("\n"))
            : new Set();
    }

    return englishWords.has(word.toLowerCase());
}

/** Terms that come up in development meetings. The vocabulary always includes them. */
export const DEV_GLOSSARY = [
    "React",
    "React Query",
    "TanStack Query",
    "React Native",
    "Redux",
    "Redux Toolkit",
    "Redux Saga",
    "saga",
    "sagas",
    "Zustand",
    "Jotai",
    "Recoil",
    "MobX",
    "TypeScript",
    "JavaScript",
    "ESLint",
    "Prettier",
    "Biome",
    "Vite",
    "Rsbuild",
    "Rspack",
    "webpack",
    "Next.js",
    "Expo",
    "Storybook",
    "Vitest",
    "Jest",
    "Playwright",
    "Cypress",
    "GraphQL",
    "Apollo",
    "Axios",
    "Zod",
    "Tailwind",
    "Node.js",
    "Bun",
    "npm",
    "pnpm",
    "GitHub",
    "GitLab",
    "merge request",
    "pull request",
    "Claude",
    "Codex",
    "Cursor",
    "Docker",
    "Kubernetes",
    "useQuery",
    "useMutation",
    "useSelector",
    "queryKey",
    "queryOptions",
    "queryClient",
    "staleTime",
    "invalidate",
    "refetch",
    "SkeletonLoader",
    "reducer",
    "middleware",
    "selector",
    "dispatch",
    "Suspense",
];

/** Czech and English spellings of one sound collapse to one letter, so "Zushtent" and "Zustand" meet. */
const SOUND_RULES: Array<[RegExp, string]> = [
    [/sch|sh|š|ś/g, "s"],
    [/zh|ž/g, "z"],
    [/tch|ch|č|ć/g, "c"],
    [/ř/g, "r"],
    [/ck|q/g, "k"],
    [/ph/g, "f"],
    [/th/g, "t"],
    [/x/g, "ks"],
    [/w/g, "v"],
    [/[yj]/g, "i"],
    [/c(?=[aoutkdr]|$)/g, "k"],
    [/c/g, "s"],
    [/ou|au/g, "a"],
];

/** Letters only Czech writes. A run that has one is a Czech word, so it is never a misheard English term. */
const CZECH_LETTERS = /[áčďéěíňóřšťúůýž]/i;

export function phoneticKey(value: string): string {
    let key = value.toLowerCase();

    for (const [pattern, replacement] of SOUND_RULES) {
        key = key.replace(pattern, replacement);
    }

    return key
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/[^a-z0-9]/g, "")
        .replace(/(.)\1+/g, "$1");
}

/** The consonants after the first letter, which survive accent and vowel errors best. */
function skeleton(key: string): string {
    return key.slice(0, 1) + key.slice(1).replace(/[aeiou]/g, "");
}

function compact(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** "React Query" and "useSelector" are two parts each; a run of N words may only match a term of N or more parts. */
function partCount(term: string): number {
    return term.split(/[\s._-]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).length;
}

interface IndexedTerm extends VocabTerm {
    key: string;
    skeleton: string;
    compact: string;
    parts: number;
}

interface RunKeys {
    run: string;
    words: number;
    key: string;
    skeleton: string;
    compact: string;
}

function indexTerm(term: VocabTerm): IndexedTerm {
    const key = phoneticKey(term.term);
    return { ...term, key, skeleton: skeleton(key), compact: compact(term.term), parts: partCount(term.term) };
}

function runKeys(run: string): RunKeys {
    const key = phoneticKey(run);
    return { run, words: run.split(" ").length, key, skeleton: skeleton(key), compact: compact(run) };
}

function mix(run: RunKeys, term: IndexedTerm, runKey = run.key): number {
    const runSkeleton = runKey === run.key ? run.skeleton : skeleton(runKey);
    return (
        0.45 * similarityScore(runKey, term.key) +
        0.35 * similarityScore(runSkeleton, term.skeleton) +
        0.2 * similarityScore(run.compact, term.compact)
    );
}

/** Scores `run` against one term; `stem` when only the run minus a Czech case ending matches. */
function scorePair(run: RunKeys, term: IndexedTerm): { value: number; kind: TermSuggestion["kind"] } | undefined {
    if (run.words > term.parts || run.key[0] !== term.key[0] || term.key.length < 3) {
        return undefined;
    }

    const floor = term.key.length <= SHORT_KEY ? SHORT_KEY_MIN : 0;
    const lengthGap = Math.abs(run.key.length - term.key.length);

    if (lengthGap <= Math.max(2, term.key.length / 2)) {
        const value = mix(run, term);

        if (value >= floor) {
            return { value, kind: "exact" };
        }
    }

    if (run.words === 1 && run.key.length > term.key.length + 1 && run.key.length <= term.key.length + 4) {
        const value = mix(run, term, run.key.slice(0, term.key.length)) * STEM_PENALTY;

        if (value >= floor) {
            return { value, kind: "stem" };
        }
    }

    return undefined;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}.'-]*/gu;

function words(text: string): string[] {
    return (text.match(WORD_RE) ?? []).map((w) => w.replace(/[.'-]+$/, ""));
}

/**
 * Proper nouns and code names from the meeting's summary and title: the summary model usually
 * spells jargon right. A capitalized word at the start of a sentence, bullet or heading is only
 * the grammar of the summary, so it is skipped.
 */
export function termsFromText(text: string, source: string): VocabTerm[] {
    const found = new Set<string>();
    const pattern = /(^|[^\n.:!?#\-*)][ \t])((?:[A-Z][\w.]*[a-z]\w*|[a-z]+[A-Z]\w*)(?:[ \t]+[A-Z]\w+)?)/gm;

    for (const match of text.matchAll(pattern)) {
        const term = match[2]!.replace(/\.$/, "");

        if (!CZECH_LETTERS.test(term)) {
            found.add(term);
        }
    }

    return [...found].map((term) => ({ term, source }));
}

/** A `--vocab` file: a package.json (its dependency names) or plain text with one term per line. */
export function termsFromFile(path: string): VocabTerm[] {
    const raw = readFileSync(path, "utf8");
    const source = basename(path);

    if (path.endsWith(".json")) {
        const pkg = SafeJSON.parse(raw) as Record<string, Record<string, string> | undefined>;
        const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });

        return names.flatMap((name) => {
            const bare = name.replace(/^@[^/]+\//, "");
            return [
                { term: bare, source },
                { term: bare.replace(/[-_]/g, " "), source },
            ];
        });
    }

    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((term) => ({ term, source }));
}

function usefulTerm(term: string): boolean {
    return !term.includes("@") && term.split(/\s+/).length <= 3 && compact(term).length >= 3;
}

/** Dedupes by spelling; the first source that named a term keeps it. */
export function buildVocabulary(groups: VocabTerm[][]): VocabTerm[] {
    const seen = new Map<string, VocabTerm>();

    for (const term of groups.flat()) {
        const key = compact(term.term);

        if (usefulTerm(term.term) && !seen.has(key)) {
            seen.set(key, term);
        }
    }

    // "Reduxu" from a Czech summary is "Redux" with a case ending; keeping both splits the votes.
    return [...seen.entries()]
        .filter(([key]) => ![1, 2].some((cut) => key.length - cut >= 3 && seen.has(key.slice(0, -cut))))
        .map(([, term]) => term);
}

interface Scored {
    heard: string;
    kind: TermSuggestion["kind"];
    candidates: TermCandidate[];
    best: number;
}

/** A vocabulary grouped by the first letter of its phonetic key, since a match must share it. */
class TermIndex {
    private readonly byFirst = new Map<string, IndexedTerm[]>();
    private readonly known = new Set<string>();
    private readonly knownKeys = new Set<string>();

    constructor(vocab: VocabTerm[]) {
        for (const term of vocab.map(indexTerm)) {
            this.known.add(term.compact);
            this.knownKeys.add(term.key);
            const bucket = this.byFirst.get(term.key[0] ?? "") ?? [];
            bucket.push(term);
            this.byFirst.set(term.key[0] ?? "", bucket);
        }
    }

    /** True when the run is a term, or a term plus a short case ending ("Reduxu", "reducery"). */
    isKnown(run: RunKeys): boolean {
        if (this.known.has(run.compact)) {
            return true;
        }

        for (let cut = 1; cut <= MAX_ENDING && cut < run.compact.length - 2; cut++) {
            if (this.known.has(run.compact.slice(0, -cut))) {
                return true;
            }
        }

        for (let cut = 1; cut <= MAX_SOUND_ENDING && cut < run.key.length - 3; cut++) {
            if (this.knownKeys.has(run.key.slice(0, -cut))) {
                return true;
            }
        }

        return false;
    }

    score(run: RunKeys, context: Set<string>, minConfidence: number): Scored | undefined {
        if (
            run.key.length < MIN_KEY_LENGTH ||
            CZECH_LETTERS.test(run.run) ||
            (run.words === 1 && isEnglishWord(run.run))
        ) {
            return undefined;
        }

        const candidates: Array<TermCandidate & { kind: TermSuggestion["kind"] }> = [];

        for (const term of this.byFirst.get(run.key[0]!) ?? []) {
            const scored = scorePair(run, term);

            if (!scored) {
                continue;
            }

            const bonus = context.has(term.compact) ? CONTEXT_BONUS : 0;
            const confidence = Math.round(Math.min(1, scored.value + bonus) * 100);

            if (confidence >= minConfidence - CANDIDATE_SPREAD) {
                candidates.push({ term: term.term, source: term.source, confidence, kind: scored.kind });
            }
        }

        candidates.sort((a, b) => b.confidence - a.confidence);

        if ((candidates[0]?.confidence ?? 0) < minConfidence) {
            return undefined;
        }

        const kind = candidates[0]!.kind;
        const top = candidates
            .filter((c) => c.kind === kind)
            .slice(0, MAX_CANDIDATES)
            .map(({ kind: _kind, ...candidate }) => candidate);

        return { heard: run.run, kind, candidates: top, best: top[0]!.confidence };
    }
}

/**
 * Every 1 to 3 word run that is not already a vocabulary term but sounds like one. A run that is a
 * known term is skipped whole, so its neighbours never glue onto it.
 */
export function findSuspectTerms(options: {
    entries: TranscriptEntry[];
    vocab: VocabTerm[];
    /** Terms the meeting's summary uses; a candidate among them gets a small bonus. */
    context?: VocabTerm[];
    minConfidence?: number;
}): TermSuggestion[] {
    const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const context = new Set((options.context ?? []).map((t) => compact(t.term)));
    const index = new TermIndex(options.vocab);
    const cache = new Map<string, { known: boolean; scored?: Scored }>();
    const counts = new Map<string, { scored: Scored; occurrences: number }>();

    const lookup = (run: string) => {
        let hit = cache.get(run);

        if (!hit) {
            const keys = runKeys(run);
            const known = index.isKnown(keys);
            hit = { known, scored: known ? undefined : index.score(keys, context, minConfidence) };
            cache.set(run, hit);
        }

        return hit;
    };

    for (const entry of options.entries) {
        const tokens = words(entry.text);
        let i = 0;

        while (i < tokens.length) {
            let best: Scored | undefined;
            let knownLength = 0;

            for (let n = 1; n <= 3 && i + n <= tokens.length; n++) {
                const hit = lookup(tokens.slice(i, i + n).join(" "));

                if (hit.known) {
                    knownLength = n;
                    continue;
                }

                if (hit.scored && (!best || hit.scored.best >= best.best + LONGER_RUN_MARGIN)) {
                    best = hit.scored;
                }
            }

            if (knownLength > 0) {
                i += knownLength;
                continue;
            }

            if (!best) {
                i++;
                continue;
            }

            const key = best.heard.toLowerCase();
            const seen = counts.get(key);
            counts.set(key, { scored: seen?.scored ?? best, occurrences: (seen?.occurrences ?? 0) + 1 });
            i += best.heard.split(" ").length;
        }
    }

    return [...counts.values()]
        .map(({ scored, occurrences }) => ({
            heard: scored.heard,
            occurrences,
            kind: scored.kind,
            candidates: scored.candidates,
        }))
        .sort((a, b) => b.candidates[0]!.confidence - a.candidates[0]!.confidence || b.occurrences - a.occurrences);
}

export interface TermFix {
    heard: string;
    replacement: string;
}

export const FIX_SEPARATOR = "::";

/** One `--fix-term` value for a heard word and its replacement. */
export function fixArg(heard: string, replacement: string): string {
    return `${heard}${FIX_SEPARATOR}${replacement}`;
}

/**
 * `--fix-term` values, one fix each: `heard::Replacement` (any replacement, so the caller decides),
 * a bare `heard` (its top candidate), or `all` (every non-inflected suspect at or above the threshold).
 */
export function selectFixes(specs: string[], suggestions: TermSuggestion[], minConfidence: number): TermFix[] {
    const byHeard = new Map(suggestions.map((s) => [s.heard.toLowerCase(), s]));

    return specs.flatMap((spec) => {
        if (spec === "all") {
            return suggestions
                .filter((s) => s.kind === "exact" && s.candidates[0]!.confidence >= minConfidence)
                .map((s) => ({ heard: s.heard, replacement: s.candidates[0]!.term }));
        }

        const at = spec.indexOf(FIX_SEPARATOR);

        if (at >= 0) {
            const heard = spec.slice(0, at).trim();
            const replacement = spec.slice(at + FIX_SEPARATOR.length).trim();

            if (!heard || !replacement) {
                throw new Error(`--fix-term "${spec}": expected "heard${FIX_SEPARATOR}Replacement"`);
            }

            return [{ heard, replacement }];
        }

        const suggestion = byHeard.get(spec.toLowerCase());

        if (!suggestion) {
            throw new Error(
                `--fix-term "${spec}" is not among the suspect terms; name the replacement: "${fixArg(spec, "<replacement>")}"`
            );
        }

        return [{ heard: suggestion.heard, replacement: suggestion.candidates[0]!.term }];
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces whole-word occurrences only, case-insensitively, keeping every other character. */
export function applyFixes(
    entries: TranscriptEntry[],
    fixes: TermFix[]
): { entries: TranscriptEntry[]; replaced: number } {
    let replaced = 0;
    const patterns = fixes.map((fix) => ({
        re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(fix.heard).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu"),
        replacement: fix.replacement,
    }));

    const next = entries.map((entry) => {
        let text = entry.text;

        for (const { re, replacement } of patterns) {
            text = text.replace(re, () => {
                replaced++;
                return replacement;
            });
        }

        return { ...entry, text };
    });

    return { entries: next, replaced };
}
