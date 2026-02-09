/**
 * Workitem Pattern System
 *
 * Core logic for extracting workitem IDs from commit messages and branch names
 * using configurable regex patterns stored in Storage("git").
 */

import logger from "@app/logger";
import type { DetailedCommitInfo } from "@app/utils/git";
import { Storage } from "@app/utils/storage";

export interface WorkitemPattern {
    regex: string;
    source: "commit-message" | "branch-name" | "both";
    description?: string;
    captureGroup: number;
}

export interface WorkitemRef {
    id: number;
    source: "commit-message" | "branch-name";
    pattern: string;
    match: string;
}

export interface SuggestedPattern {
    pattern: WorkitemPattern;
    matchCount: number;
    sampleMatches: string[];
}

const DEFAULT_PATTERNS: WorkitemPattern[] = [
    { regex: "col-(\\d+)", source: "commit-message", captureGroup: 1, description: "col-XXXXX" },
    { regex: "#(\\d{5,6})", source: "commit-message", captureGroup: 1, description: "#XXXXX" },
    { regex: "COL-(\\d+)-", source: "branch-name", captureGroup: 1, description: "COL-XXXXX branch" },
];

const SUGGEST_TEMPLATES: WorkitemPattern[] = [
    { regex: "col-(\\d+)", source: "commit-message", captureGroup: 1, description: "col-XXXXX (commit message)" },
    { regex: "#(\\d{5,6})", source: "commit-message", captureGroup: 1, description: "#XXXXX (commit message)" },
    {
        regex: "(\\w+)-(\\d+)",
        source: "commit-message",
        captureGroup: 2,
        description: "PREFIX-NUMBER (commit message)",
    },
    {
        regex: "feat\\(.*?(\\d{5,6})",
        source: "commit-message",
        captureGroup: 1,
        description: "feat(...ID) conventional commit",
    },
    {
        regex: "fix\\(.*?(\\d{5,6})",
        source: "commit-message",
        captureGroup: 1,
        description: "fix(...ID) conventional commit",
    },
    { regex: "COL-(\\d+)-", source: "branch-name", captureGroup: 1, description: "COL-XXXXX branch pattern" },
    {
        regex: "(\\w+)-(\\d+)-",
        source: "branch-name",
        captureGroup: 2,
        description: "PREFIX-NUMBER-desc branch pattern",
    },
];

export function loadWorkitemPatterns(): WorkitemPattern[] {
    return DEFAULT_PATTERNS;
}

export async function loadWorkitemPatternsAsync(): Promise<WorkitemPattern[]> {
    const storage = new Storage("git");
    const patterns = await storage.getConfigValue<WorkitemPattern[]>("workitemPatterns");

    if (patterns && patterns.length > 0) {
        return patterns;
    }

    return DEFAULT_PATTERNS;
}

function applyPattern(text: string, pattern: WorkitemPattern): WorkitemRef[] {
    const refs: WorkitemRef[] = [];
    const re = new RegExp(pattern.regex, "gi");
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
        const capturedValue = match[pattern.captureGroup];

        if (capturedValue && /^\d+$/.test(capturedValue)) {
            const id = parseInt(capturedValue, 10);
            refs.push({
                id,
                source: pattern.source === "both" ? "commit-message" : pattern.source,
                pattern: pattern.regex,
                match: match[0],
            });
        }
    }

    return refs;
}

export function extractFromMessage(message: string, patterns?: WorkitemPattern[]): WorkitemRef[] {
    const activePatterns = patterns ?? DEFAULT_PATTERNS;
    const refs: WorkitemRef[] = [];

    for (const pattern of activePatterns) {
        if (pattern.source === "branch-name") {
            continue;
        }

        const found = applyPattern(message, pattern);
        for (const ref of found) {
            ref.source = "commit-message";
            refs.push(ref);
        }
    }

    return refs;
}

export function extractFromBranch(branchName: string, patterns?: WorkitemPattern[]): WorkitemRef[] {
    const activePatterns = patterns ?? DEFAULT_PATTERNS;
    const refs: WorkitemRef[] = [];

    for (const pattern of activePatterns) {
        if (pattern.source === "commit-message") {
            continue;
        }

        const found = applyPattern(branchName, pattern);
        for (const ref of found) {
            ref.source = "branch-name";
            refs.push(ref);
        }
    }

    return refs;
}

export function extractWorkitemIds(
    commits: DetailedCommitInfo[],
    branches?: string[],
    patterns?: WorkitemPattern[]
): Map<number, WorkitemRef[]> {
    const result = new Map<number, WorkitemRef[]>();

    for (const commit of commits) {
        const refs = extractFromMessage(commit.message, patterns);
        for (const ref of refs) {
            const existing = result.get(ref.id) ?? [];
            existing.push(ref);
            result.set(ref.id, existing);
        }
    }

    if (branches) {
        for (const branch of branches) {
            const refs = extractFromBranch(branch, patterns);
            for (const ref of refs) {
                const existing = result.get(ref.id) ?? [];
                existing.push(ref);
                result.set(ref.id, existing);
            }
        }
    }

    if (result.size === 0 && (!patterns || patterns === DEFAULT_PATTERNS)) {
        logger.debug("No workitem patterns configured. Run: tools git configure-workitem-patterns --suggest");
    }

    return result;
}

export function suggestPatterns(messages: string[], branches: string[]): SuggestedPattern[] {
    const suggestions: SuggestedPattern[] = [];

    for (const template of SUGGEST_TEMPLATES) {
        const re = new RegExp(template.regex, "gi");
        let matchCount = 0;
        const sampleMatches: string[] = [];

        const textsToSearch = template.source === "branch-name" ? branches : messages;

        for (const text of textsToSearch) {
            let match: RegExpExecArray | null;
            re.lastIndex = 0;

            while ((match = re.exec(text)) !== null) {
                matchCount++;

                if (sampleMatches.length < 3) {
                    sampleMatches.push(match[0]);
                }
            }
        }

        if (matchCount > 0) {
            suggestions.push({
                pattern: template,
                matchCount,
                sampleMatches,
            });
        }
    }

    return suggestions.sort((a, b) => b.matchCount - a.matchCount);
}

export function validatePattern(regex: string): { valid: boolean; error?: string } {
    try {
        new RegExp(regex);

        // A regex with capture groups will have a source containing '('
        const hasCapture = /\([^?]/.test(regex) || /\(\?</.test(regex);

        if (!hasCapture) {
            return { valid: false, error: "Pattern must have at least one capture group for the workitem ID" };
        }

        return { valid: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { valid: false, error: `Invalid regex: ${message}` };
    }
}
