import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { createGrokUsageParser } from "@genesiscz/utils/ai/usage/transcripts/grok";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    isNativeTranscript,
    nativeSessionRoots,
    nativeTranscriptMaxDepth,
} from "@genesiscz/utils/providers/session-paths";
import { spendScopeRoots } from "./account-scope";
import { isRecord } from "./parse-helpers";
import type { DriverRoot, MonitorDriver } from "./types";

/**
 * Grok CLI sessions: `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl`
 * (`GROK_HOME` overrides the root). Only `updates.jsonl` carries usage —
 * `events.jsonl` and `chat_history.jsonl` are ignored, matching ccusage's
 * discovery (`rust/adapters/grok/src/paths.rs:32` `discover_session_files`).
 *
 * The usage line is a JSON-RPC notification:
 * `{"timestamp":…,"params":{"update":{"sessionUpdate":"turn_completed","usage":{…}}}}`,
 * with a per-model breakdown under `usage.modelUsage`.
 *
 * Token and cost semantics mirror `parse_session_files`
 * (`rust/adapters/grok/src/parser.rs:207-325`):
 *   - `cachedReadTokens` and `cacheCreationTokens` are SUBSETS of `inputTokens`,
 *     so billable input is `input - cachedRead - cacheCreation`
 *     (`split_input_tokens`, parser.rs:170).
 *   - `reasoningTokens` is a subset of `outputTokens` and is never billed twice.
 *   - `costUsdTicks` is fixed-point USD at 1e-10 per tick and is AUTHORITATIVE
 *     (parser.rs:140-153): Grok prices each API request separately and a
 *     `turn_completed` row only carries the per-turn sum, so recomputing from
 *     those totals cannot reproduce the figure Grok actually billed.
 *   - dedup is `eventId|model`, falling back to the token fingerprint.
 */

/** `summary.json` next to `updates.jsonl` names the session's model. */
function readSessionModel(file: string): string | undefined {
    const summary = join(dirname(file), "summary.json");

    if (!existsSync(summary)) {
        return undefined;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(summary, "utf8"), { strict: true });

        if (isRecord(parsed) && typeof parsed.current_model_id === "string") {
            return parsed.current_model_id;
        }
    } catch (err) {
        logger.debug({ err, summary }, "ai-spend grok: unreadable session summary");
    }

    return undefined;
}

/**
 * `grok-4.6-build` is the build-agent flavour of `grok-4.6`, so peel the
 * `-build` suffix as ccusage's `pricing_candidates` does
 * (`rust/adapters/grok/src/parser.rs:177`). The `xai/` and `x-ai/` prefixed
 * candidates ccusage also tries are skipped: this tool's pricing table is keyed
 * by bare catalog ids, so a prefixed key can never hit.
 */
function grokPriceCandidates(model: string): string[] {
    const candidates: string[] = [];
    const push = (value: string | null): void => {
        if (value && !candidates.includes(value)) {
            candidates.push(value);
        }
    };

    const stripped = model.startsWith("[grok] ") ? model.slice("[grok] ".length).trim() : model.trim();

    push(stripped);
    push(stripModelVariantSuffix(stripped));

    if (stripped.endsWith("-build")) {
        const base = stripped.slice(0, -"-build".length);
        push(base);
        push(stripModelVariantSuffix(base));
    }

    return candidates;
}

export const grokDriver: MonitorDriver = {
    id: "grok",

    roots(home: string): string[] {
        return nativeSessionRoots("grok", home);
    },

    /**
     * The account's own home, plus every `~/.genesis-tools/grok/worker-home*`
     * when it owns the default login — the harness authenticates workers with
     * that credential, so their turns are this account's spend, and they never
     * reach the call log.
     */
    rootsForAccounts(accounts: AccountEntry[]): DriverRoot[] {
        return spendScopeRoots({ agent: "grok", accounts });
    },

    isTranscript(name: string): boolean {
        return isNativeTranscript("grok", name);
    },

    // sessions/<encoded-cwd>/<session-id>/updates.jsonl
    maxDepth: nativeTranscriptMaxDepth("grok"),

    createParser(options) {
        return createGrokUsageParser({
            ...options,
            resolveCurrentModel: () => readSessionModel(options.file),
        });
    },

    priceCandidates: grokPriceCandidates,
};
