import { type TranscludeOptions, transclude } from "./engine";
import type { TransclusionToken } from "./types";

export type RecheckStatus = "unchanged" | "changed" | "failed" | "frozen";

export interface RecheckOutcome {
    raw: string;
    kind: string;
    status: RecheckStatus;
    capturedAt?: string;
    checkedAt: string;
    /** For `changed`: the first line that differs, as captured and as it reads now. */
    was?: string;
    now?: string;
    error?: string;
}

/**
 * Re-resolves every stored `verify` token and compares its content signature with the captured one.
 * `substitute` tokens are frozen on purpose and come back as `frozen` without being resolved. Read-only:
 * it never writes the new content back, so the stored snapshot stays what the reader was shown.
 */
export async function recheck(
    tokens: TransclusionToken[],
    options: Omit<TranscludeOptions, "cwd" | "onFailure"> & { cwd?: string }
): Promise<RecheckOutcome[]> {
    const checkedAt = (options.now?.() ?? new Date()).toISOString();
    const outcomes: RecheckOutcome[] = [];

    for (const token of tokens) {
        const base = {
            raw: token.raw,
            kind: token.kind,
            checkedAt,
            ...(token.capturedAt ? { capturedAt: token.capturedAt } : {}),
        };

        if (token.action !== "verify") {
            outcomes.push({ ...base, status: "frozen" });
            continue;
        }

        const result = await transclude(token.raw, {
            ...options,
            cwd: token.cwd ?? options.cwd ?? process.cwd(),
            callerReports: true,
            onFailure: "mark",
        });
        const fresh = result.tokens[0];

        if (!fresh?.ok) {
            outcomes.push({ ...base, status: "failed", error: fresh?.error ?? "the token no longer parses" });
            continue;
        }

        if (fresh.signature === token.signature) {
            outcomes.push({ ...base, status: "unchanged" });
            continue;
        }

        outcomes.push({ ...base, status: "changed", ...firstDifference(token.snapshot ?? "", fresh.snapshot ?? "") });
    }

    return outcomes;
}

/** The first line that differs between two texts, each cut to 120 characters. */
export function firstDifference(was: string, now: string): { was: string; now: string } {
    const before = was.split("\n");
    const after = now.split("\n");
    const length = Math.max(before.length, after.length);
    const cut = (line: string | undefined): string => {
        const text = (line ?? "(nothing)").trim() || "(blank line)";
        return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    };

    for (let i = 0; i < length; i++) {
        if (before[i] !== after[i]) {
            return { was: cut(before[i]), now: cut(after[i]) };
        }
    }

    return { was: "(same text)", now: "(same text)" };
}

/** One human line per outcome, for the CLI and the MCP result. */
export function formatRecheck(outcome: RecheckOutcome): string {
    const since = outcome.capturedAt ? `captured ${outcome.capturedAt.slice(0, 16).replace("T", " ")} UTC` : "";

    switch (outcome.status) {
        case "unchanged":
            return `unchanged: ${outcome.raw} (${since})`;
        case "changed":
            return `changed since capture: ${outcome.raw}: was "${outcome.was}", now "${outcome.now}" (as of ${outcome.checkedAt.slice(0, 16).replace("T", " ")} UTC; ${since})`;
        case "failed":
            return `re-check failed: ${outcome.raw}: ${outcome.error}`;
        case "frozen":
            return `frozen (substitute, not re-checked): ${outcome.raw}`;
    }
}
