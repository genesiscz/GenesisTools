import {
    manifestChangedLines,
    REVIEW_EFFORTS,
    type ReviewEffort,
    type ReviewManifest,
} from "@genesiscz/utils/worker/contract";
import type { CodexReviewConfig, ReviewVerdict } from "./types";

/**
 * Reasoning tokens per 100 changed lines a tier must reach. Measured 2026-10-22 on a 6,200-line diff: medium
 * spent about 40, xhigh about 390. First guesses from one day of data; tune them from `tools codex reviews`.
 */
export const REASONING_FLOOR_PER_100_LINES: Record<ReviewEffort, number> = {
    low: 0,
    medium: 0,
    high: 100,
    xhigh: 250,
    max: 250,
};

/** The most unread files one steer names; the rest are counted. */
const STEER_FILE_LIMIT = 40;

export interface ParsedFinding {
    index: number;
    text: string;
    ok: boolean;
}

export interface ParsedReviewReport {
    coverage: { reviewed: number; total: number } | null;
    notReviewed: Array<{ path: string; reason: string | null }>;
    findings: ParsedFinding[];
    findingsNone: boolean;
    ran: boolean;
}

/**
 * A pair of `*`, `**`, `_` or `__` around a phrase: opened after a space or the line start, closed before a space,
 * punctuation or the line end. An underscore inside a word (`app_icon.png`, `__init__.py`) is not emphasis.
 */
const EMPHASIS = /(^|[\s([])(\*{1,2}|_{1,2})(?=\S)(.*?\S)\2(?=$|[\s)\]:,;!?]|\.(?:\s|$))/g;

/** Markdown emphasis, code ticks and a bullet a model wraps around the fixed lines; they carry no meaning here. */
function plain(line: string): string {
    let text = line.replace(/`/g, "").replace(/^\s*[*-]\s+/, "");

    // Twice at most: `***both***` is one pair inside another.
    for (let pass = 0; pass < 2; pass++) {
        text = text.replace(EMPHASIS, "$1$3");
    }

    return text.trim();
}

const FINDING_START = /^(\d+)[.)]\s+(.*)$/;
/** `[Severity] path:line`: the path runs up to its `:line`, so a path with spaces in it (`src/my file.ts:12`) parses. */
const FINDING_SHAPE = /^\[(critical|high|medium|low)\]\s+\S(?:[^:]*?\S)?:\d+(?=$|[\s:,;)\-\u2013\u2014])/i;
const SECTION_END = /^(ran|files reviewed|not reviewed|result|at|changed|verify|open|findings):/i;

function parseNotReviewed(value: string): ParsedReviewReport["notReviewed"] {
    if (/^none\.?$/i.test(value.trim())) {
        return [];
    }

    return value
        .split(/,\s+(?![^()]*\))/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const match = /^(.*?)\s*\((.*)\)\s*$/.exec(entry);
            return match ? { path: match[1].trim(), reason: match[2].trim() || null } : { path: entry, reason: null };
        });
}

/** Reads the review shape the contract asks for (`reviewLines`): numbered findings, `Ran:`, `Files reviewed:`, `Not reviewed:`. */
export function parseReviewReport(report: string): ParsedReviewReport {
    const parsed: ParsedReviewReport = {
        coverage: null,
        notReviewed: [],
        findings: [],
        findingsNone: false,
        ran: false,
    };
    let current: ParsedFinding | null = null;

    for (const raw of report.split("\n")) {
        const line = plain(raw);
        const coverage = /^files reviewed:\s*(\d+)\s*(?:of|\/)\s*(\d+)/i.exec(line);

        if (coverage) {
            parsed.coverage = { reviewed: Number(coverage[1]), total: Number(coverage[2]) };
        }

        const notReviewed = /^not reviewed:\s*(.*)$/i.exec(line);

        if (notReviewed) {
            parsed.notReviewed = parseNotReviewed(notReviewed[1]);
        }

        if (/^ran:/i.test(line)) {
            parsed.ran = true;
        }

        if (/^findings:\s*none\b/i.test(line)) {
            parsed.findingsNone = true;
        }

        if (SECTION_END.test(line)) {
            current = null;
            continue;
        }

        const start = FINDING_START.exec(line);

        if (start && !parsed.ran && !parsed.coverage) {
            current = { index: Number(start[1]), text: start[2], ok: false };
            parsed.findings.push(current);
            continue;
        }

        if (current && line) {
            current.text = `${current.text} ${line}`;
        }
    }

    for (const finding of parsed.findings) {
        finding.ok = FINDING_SHAPE.test(finding.text) && /scenario:/i.test(finding.text) && /fix:/i.test(finding.text);
    }

    return parsed;
}

export interface GateCheck {
    ok: boolean;
    detail: string;
}

export interface ReviewGateChecks {
    coverage: GateCheck & { reviewed: number | null; total: number; unread: string[] };
    reasoning: GateCheck & { per100Lines: number | null; floor: number };
    shape: GateCheck & { findings: number; malformed: number[] };
}

/** Reasoning tokens per 100 changed lines, rounded; null when the tokens are unknown. */
export function reasoningPer100Lines(reasoningTokens: number | null, manifest: ReviewManifest): number | null {
    if (reasoningTokens === null) {
        return null;
    }

    return Math.round((reasoningTokens * 100) / Math.max(1, manifestChangedLines(manifest)));
}

/**
 * Coverage against the manifest: the reported total is the manifest's, the reviewed count plus the excused binary
 * files reach it, and the Not reviewed line names no text file. Exported for `reviews import`, which reaches the
 * same verdict from a backfilled final message.
 */
export function checkCoverage(
    parsed: ParsedReviewReport,
    manifest: ReviewManifest,
    report: string
): ReviewGateChecks["coverage"] {
    const total = manifest.files.length;

    if (!parsed.coverage) {
        return {
            ok: false,
            detail: "no `Files reviewed: n of N` line",
            reviewed: null,
            total,
            unread: manifest.files.map((file) => file.path),
        };
    }

    const { reviewed } = parsed.coverage;
    const binary = new Set(manifest.files.filter((file) => file.binary).map((file) => file.path));
    // A binary file has no text to read: named with a reason, it does not count as unread. Each one counts once,
    // so naming the same binary twice cannot make up for a text file left unread.
    const excused = new Set(
        parsed.notReviewed.filter((entry) => entry.reason && binary.has(entry.path)).map((entry) => entry.path)
    ).size;
    // A text file on the Not reviewed line is an admitted gap, whatever the count says.
    const named = [...new Set(parsed.notReviewed.map((entry) => entry.path).filter((path) => !binary.has(path)))];
    const ok = parsed.coverage.total === total && reviewed + excused >= total && named.length === 0;

    if (ok) {
        return { ok, detail: `${reviewed} of ${total} files reviewed`, reviewed, total, unread: [] };
    }

    const missing = total - reviewed - excused;
    // The worker named fewer files than it skipped: the manifest files its report never mentions are the best guess.
    const unmentioned =
        named.length >= missing
            ? []
            : manifest.files.map((file) => file.path).filter((path) => !named.includes(path) && !report.includes(path));
    const detail =
        parsed.coverage.total !== total
            ? `reported ${reviewed} of ${parsed.coverage.total}, but the manifest has ${total} files`
            : reviewed + excused >= total
              ? `${reviewed} of ${total} files reviewed, but Not reviewed names ${named.length} text file(s)`
              : `${reviewed} of ${total} files reviewed`;

    return { ok, detail, reviewed, total, unread: [...new Set([...named, ...unmentioned])] };
}

function checkShape(parsed: ParsedReviewReport): ReviewGateChecks["shape"] {
    const malformed = parsed.findings.filter((finding) => !finding.ok).map((finding) => finding.index);
    const problems: string[] = [];

    if (parsed.findings.length === 0 && !parsed.findingsNone) {
        problems.push("no numbered findings and no `Findings: none` line");
    }

    if (malformed.length > 0) {
        problems.push(
            `findings ${malformed.map((index) => `#${index}`).join(", ")} lack severity, path:line, Scenario or Fix`
        );
    }

    if (!parsed.ran) {
        problems.push("no `Ran:` line");
    }

    return {
        ok: problems.length === 0,
        detail: problems.length === 0 ? `${parsed.findings.length} findings parse` : problems.join("; "),
        findings: parsed.findings.length,
        malformed,
    };
}

/** The three depth checks of one review turn: coverage against the manifest, the reasoning floor, and finding shape. */
export function checkReview(input: {
    report: string;
    manifest: ReviewManifest;
    effort: ReviewEffort;
    /** Reasoning tokens of every review turn of the session so far; null when the backend did not report them. */
    reasoningTokens: number | null;
}): ReviewGateChecks {
    const parsed = parseReviewReport(input.report);
    const floor = REASONING_FLOOR_PER_100_LINES[input.effort];
    const per100Lines = reasoningPer100Lines(input.reasoningTokens, input.manifest);
    const reasoningOk = per100Lines === null || per100Lines >= floor;

    return {
        coverage: checkCoverage(parsed, input.manifest, input.report),
        reasoning: {
            ok: reasoningOk,
            detail:
                per100Lines === null
                    ? "reasoning tokens unknown"
                    : `${per100Lines} reasoning tokens per 100 changed lines, ${input.effort} floor ${floor}`,
            per100Lines,
            floor,
        },
        shape: checkShape(parsed),
    };
}

export function nextReviewEffort(effort: ReviewEffort): ReviewEffort | null {
    const index = REVIEW_EFFORTS.indexOf(effort);
    return index >= 0 && index < REVIEW_EFFORTS.length - 1 ? REVIEW_EFFORTS[index + 1] : null;
}

function failedDetails(checks: ReviewGateChecks): string[] {
    return (["coverage", "reasoning", "shape"] as const)
        .filter((key) => !checks[key].ok)
        .map((key) => `${key}: ${checks[key].detail}`);
}

/** The one steer the gate sends: the unread files by name, the reasoning gap, the findings that do not parse. */
export function steerText(checks: ReviewGateChecks, effort: ReviewEffort): string {
    const lines = ["The review gate found this review incomplete. Continue the same review now:"];
    const unread = checks.coverage.unread;

    if (!checks.coverage.ok && unread.length > 0) {
        const named = unread.slice(0, STEER_FILE_LIMIT).join(", ");
        const more =
            unread.length > STEER_FILE_LIMIT ? `, and ${unread.length - STEER_FILE_LIMIT} more manifest files` : "";
        lines.push(`You did not read: ${named}${more}. Review them now with the same output shape.`);
    } else if (!checks.coverage.ok) {
        lines.push(`Coverage: ${checks.coverage.detail}. Account for every file of the manifest.`);
    }

    if (!checks.reasoning.ok) {
        lines.push(
            `Depth: ${checks.reasoning.detail}. Go deeper at the ${effort} tier: open the callers and tests of the riskiest changes and probe each finding.`
        );
    }

    if (!checks.shape.ok) {
        lines.push(
            `Shape: ${checks.shape.detail}. Write each finding as \`N. [Severity] path:line - defect. Scenario: ... Fix: ...\`.`
        );
    }

    lines.push(
        `End with the full findings list (earlier ones included), the Ran line, \`Files reviewed: <n> of ${checks.coverage.total}\`, the Not reviewed line and the five report lines.`
    );
    return lines.join("\n");
}

export interface GateDecision {
    verdict: ReviewVerdict;
    reason: string;
    /** For `steered`: the text sent to the same session. */
    steer?: string;
    /** For `escalated`: the tier of the new session. */
    nextEffort?: ReviewEffort;
}

/**
 * What the gate does after a review turn. At most two automatic steps per review chain: the first miss steers the
 * same session (step 0), the second reruns one tier higher in a new session (step 1), and a miss after that, or a
 * miss with no tier left, is `shallow`. A shallow tier the caller asked for (`--allow-shallow`) is never tuned up.
 */
export function decideGate(
    checks: ReviewGateChecks,
    config: Pick<CodexReviewConfig, "effort" | "step" | "allowShallow">
): GateDecision {
    const misses = failedDetails(checks);

    if (config.effort === "low") {
        return { verdict: "shallow", reason: "low is triage only (--allow-shallow); the depth gate does not apply" };
    }

    if (misses.length === 0) {
        return {
            verdict: "pass",
            reason: `${checks.coverage.detail}; ${checks.reasoning.detail}; ${checks.shape.detail}`,
        };
    }

    const missed = misses.join("; ");

    if (config.effort === "medium" && config.allowShallow) {
        return { verdict: "shallow", reason: `${missed} (medium with --allow-shallow: no automatic step)` };
    }

    if (config.step === 0) {
        return { verdict: "steered", reason: missed, steer: steerText(checks, config.effort) };
    }

    const next = nextReviewEffort(config.effort);

    if (config.step === 1 && next) {
        return { verdict: "escalated", reason: `${missed}; rerun at ${next}`, nextEffort: next };
    }

    return {
        verdict: "shallow",
        reason: `${missed}; ${config.step >= 2 ? "both automatic steps are spent" : `no tier above ${config.effort}`}`,
    };
}
