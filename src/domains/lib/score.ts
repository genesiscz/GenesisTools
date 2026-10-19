import { parseDomain } from "@app/domains/lib/domain";
import { tldTier } from "@app/domains/lib/tlds";
import type { Candidate, CheckResult } from "@app/domains/lib/types";

const VOWEL = /[aeiouy]/;

/** 0..1: how sayable a label is. Penalizes long consonant runs and vowel-free stretches. */
export function pronounceability(label: string): number {
    const letters = label.replace(/[^a-z]/g, "");
    if (!letters) {
        return 0;
    }

    let longestConsonantRun = 0;
    let run = 0;
    let vowels = 0;
    for (const char of letters) {
        if (VOWEL.test(char)) {
            vowels++;
            run = 0;
        } else {
            run++;
            longestConsonantRun = Math.max(longestConsonantRun, run);
        }
    }

    const ratio = vowels / letters.length;
    const ratioScore = 1 - Math.min(1, Math.abs(ratio - 0.4) / 0.4);
    const runPenalty = Math.max(0, longestConsonantRun - 2) * 0.25;
    return Math.max(0, Math.min(1, ratioScore - runPenalty));
}

/**
 * 0..100 for a candidate, before or after a check. Short, sayable, hyphen-free labels on a good TLD
 * score high; a hack gets a bonus; a known price pulls the score down as it grows.
 */
export function scoreCandidate(candidate: Candidate, result?: CheckResult): number {
    const parsed = parseDomain(candidate.domain);
    if (!parsed) {
        return 0;
    }

    const { label, tld } = parsed;
    let score = 50;
    score += Math.max(-25, 20 - (label.length - 4) * 2.5);
    score += (pronounceability(label) - 0.6) * 35;
    score += (tldTier(tld) - 5) * 3;
    if (label.includes("-")) {
        score -= 12;
    }

    if (/\d/.test(label)) {
        score -= 8;
    }

    if (candidate.sources.includes("hacks")) {
        score += 15;
    }

    if (candidate.sources.length > 1) {
        score += 3;
    }

    if (result) {
        if (result.status === "taken" || result.status === "reserved") {
            score -= 60;
        } else if (result.status === "for-sale") {
            score -= 40;
        } else if (result.status === "unknown") {
            score -= 15;
        }

        const price = result.price?.registration;
        if (price !== undefined) {
            score -= Math.min(40, Math.log10(Math.max(1, price / 10)) * 15);
        }
    }

    return Math.round(Math.max(0, Math.min(100, score)));
}
