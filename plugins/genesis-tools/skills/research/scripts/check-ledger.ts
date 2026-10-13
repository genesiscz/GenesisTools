#!/usr/bin/env bun
/**
 * Mechanical check of a research report's "Claims ledger" (see the CLAIMS block in SKILL.md).
 *
 * For each ledger line it pairs every quoted passage ("..." or `...`) with the nearest link in the proof (a web
 * page, a GitHub blob link read from raw.githubusercontent.com, or a local log file) and confirms the passage is
 * there. It proves the evidence exists where the report says. Whether the evidence supports the claim is left to
 * the reader, so a line marked "QUOTE MISSING" or "run verify by hand" is the one to look at first.
 *
 * Usage: bun check-ledger.ts <report.md> [--json]
 */

export type FetchPage = (target: string) => Promise<string>;

export interface LedgerLine {
    confidence: number;
    claim: string;
    proof: string;
    verify: string;
}

export interface LineCheck {
    confidence: number;
    claim: string;
    verdict: "found" | "mostly" | "missing" | "unloaded" | "by-hand" | "no-proof";
    detail: string;
}

/** The `[NN%] claim (proof: ...) verify: ...` lines under the "Claims ledger" heading, up to the next heading. */
export function ledgerLines(report: string): LedgerLine[] {
    const start = report.search(/^#+\s*Claims ledger/im);
    if (start < 0) {
        return [];
    }

    const after = report.slice(start).split("\n").slice(1);
    const end = after.findIndex((line) => /^#+\s/.test(line));
    return (end < 0 ? after : after.slice(0, end))
        .filter((line) => /\[\d{1,3}%\]/.test(line))
        .map((line) => ({
            confidence: Number(line.match(/\[(\d{1,3})%\]/)?.[1]),
            claim: line
                .replace(/\(proof:[\s\S]*$/i, "")
                .replace(/^[-*\d.\s]*\[\d+%\]\s*/, "")
                .trim(),
            proof:
                line.match(/\(proof:\s*([\s\S]*?)\)\s*(verify:|$)/i)?.[1] ?? line.match(/proof:\s*(.*)$/i)?.[1] ?? "",
            verify: line.match(/verify:\s*(.*)$/i)?.[1] ?? "",
        }));
}

/** Each quoted passage of a proof with the link nearest to it; the verify URL stands in when the proof has none. */
export function quotePairs(proof: string, verify: string): Array<{ target: string; quote: string }> {
    const links = [...proof.matchAll(/\]\(([^)\s]+)\)|(https?:\/\/[^\s)>\]`'"]+)/g)].map((match) => ({
        at: match.index ?? 0,
        target: (match[1] ?? match[2] ?? "").replace(/[.,;]+$/, ""),
    }));
    const verifyUrl = verify.match(/https?:\/\/[^\s)>\]`'"]+/)?.[0];
    if (links.length === 0 && verifyUrl) {
        links.push({ at: 0, target: verifyUrl });
    }

    const pairs: Array<{ target: string; quote: string }> = [];
    for (const match of proof.matchAll(/["“]([^"”]{8,})["”]|`([^`]{8,})`/g)) {
        const quote = match[1] ?? match[2] ?? "";
        if (/^https?:/.test(quote)) {
            continue;
        }

        const at = match.index ?? 0;
        const nearest = [...links].sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
        if (nearest) {
            pairs.push({ target: nearest.target, quote });
        }
    }

    return pairs;
}

function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z#0-9]+;/g, " ")
        .replace(/[`*_"“”'’\\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** found = the whole passage; mostly = at least 80% of its longer words; missing = less. */
export function findQuote(body: string, quote: string): "found" | "mostly" | "missing" | "unloaded" {
    const text = normalize(body);
    const passage = normalize(quote);
    // A short body that holds the passage (a one-line local log) is evidence; only a short body without it is unloaded.
    if (passage && text.includes(passage)) {
        return "found";
    }

    if (text.length < 50) {
        return "unloaded";
    }

    const words = passage.split(" ").filter((word) => word.length > 3);
    const share = words.filter((word) => text.includes(word)).length / Math.max(1, words.length);
    return share >= 0.8 ? "mostly" : "missing";
}

export async function checkLine(line: LedgerLine, fetchPage: FetchPage): Promise<LineCheck> {
    const base = { confidence: line.confidence, claim: line.claim };
    if (/^\s*none\b/i.test(line.proof)) {
        return { ...base, verdict: "no-proof", detail: "the report gives no proof" };
    }

    const pairs = quotePairs(line.proof, line.verify);
    if (pairs.length === 0) {
        return { ...base, verdict: "by-hand", detail: line.verify ? `run: ${line.verify}` : "no quote to check" };
    }

    const results = await Promise.all(pairs.map(async (pair) => findQuote(await fetchPage(pair.target), pair.quote)));
    const missing = results.filter((result) => result === "missing").length;
    const verdict =
        missing > 0
            ? "missing"
            : results.includes("unloaded")
              ? "unloaded"
              : results.includes("mostly")
                ? "mostly"
                : "found";
    return { ...base, verdict, detail: `${pairs.length} quote(s): ${results.join(", ")}` };
}

/** Web pages, GitHub blob links (read raw) and local files; a page too short to hold text is read through Jina. */
export function pageFetcher(): FetchPage {
    const cache = new Map<string, Promise<string>>();
    const load = async (target: string): Promise<string> => {
        if (target.startsWith("/")) {
            return Bun.file(target)
                .text()
                .catch(() => "");
        }

        const blob = target.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^#?]+)/);
        const url = blob
            ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`
            : (target.split("#")[0] ?? target);
        const direct = await fetch(url, { signal: AbortSignal.timeout(20_000) })
            .then((response) => (response.ok ? response.text() : ""))
            .catch(() => "");
        if (blob || normalize(direct).length > 2000) {
            return direct;
        }

        // The reader is a second try for a page that renders its text with scripts; when it fails, the direct
        // body (short as it is, it may still hold the passage) is the better evidence than nothing.
        const read = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(30_000) })
            .then((response) => (response.ok ? response.text() : ""))
            .catch(() => "");
        return read || direct;
    };

    return (target) => {
        let page = cache.get(target);
        if (!page) {
            page = load(target);
            cache.set(target, page);
        }

        return page;
    };
}

/** The verdicts that leave a claim unconfirmed: its quote is not in its source, it has no proof, or the source did not load. */
const UNCONFIRMED: ReadonlySet<LineCheck["verdict"]> = new Set(["missing", "no-proof", "unloaded"]);

/** Claims at 80% or more whose evidence the check could not confirm: each needs its verify run, or a lower confidence. */
export function needsFollowUp(checks: LineCheck[]): LineCheck[] {
    return checks.filter((check) => check.confidence >= 80 && UNCONFIRMED.has(check.verdict));
}

if (import.meta.main) {
    const file = process.argv[2];
    if (!file) {
        process.stderr.write("usage: bun check-ledger.ts <report.md> [--json]\n");
        process.exit(2);
    }

    const lines = ledgerLines(await Bun.file(file).text());
    if (lines.length === 0) {
        process.stderr.write(`${file}: no "Claims ledger" section with [NN%] lines\n`);
        process.exit(2);
    }

    const fetchPage = pageFetcher();
    const checks = await Promise.all(lines.map((line) => checkLine(line, fetchPage)));
    if (process.argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
    } else {
        for (const check of checks) {
            process.stdout.write(
                `[${String(check.confidence).padStart(2)}%] ${check.verdict.padEnd(9)} ${check.claim.slice(0, 90)}\n          ${check.detail.slice(0, 160)}\n`
            );
        }

        const counts: Record<string, number> = {};
        for (const check of checks) {
            counts[check.verdict] = (counts[check.verdict] ?? 0) + 1;
        }

        process.stdout.write(`\n${checks.length} ledger lines: ${JSON.stringify(counts)}\n`);
    }

    const followUp = needsFollowUp(checks);
    if (followUp.length > 0) {
        process.stderr.write(
            `\n${followUp.length} claim(s) at 80% or more are not confirmed (missing, no-proof or unloaded); run their verify or lower them:\n${followUp.map((check) => `  [${check.confidence}%] ${check.verdict}: ${check.claim.slice(0, 90)}`).join("\n")}\n`
        );
    }

    process.exitCode = followUp.length > 0 ? 1 : 0;
}
