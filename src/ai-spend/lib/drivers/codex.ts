import { stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { createCodexUsageParser } from "@genesiscz/utils/ai/usage/transcripts/codex";
import {
    isNativeTranscript,
    nativeSessionRoots,
    nativeTranscriptMaxDepth,
} from "@genesiscz/utils/providers/session-paths";
import { spendScopeRoots } from "./account-scope";
import type { DriverRoot, MonitorDriver } from "./types";

/**
 * Codex CLI rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus
 * `archived_sessions` next to it. `CODEX_HOME` overrides the root and accepts a
 * comma-separated list, exactly as ccusage does
 * (`rust/adapters/codex/src/paths.rs:104` `codex_home_paths`).
 *
 * Two line types matter:
 *   - `{"type":"turn_context","payload":{"model":"gpt-5.6-sol",…}}` — sets the
 *     model for every later usage line in the file.
 *   - `{"type":"event_msg","payload":{"type":"token_count","info":{…}}}` — the
 *     usage itself, with a per-turn `last_token_usage` and a cumulative
 *     `total_token_usage`.
 *
 * Token semantics mirror `visit_codex_session_entry`
 * (`rust/adapters/codex/src/parser.rs:317-367`):
 *   - prefer `last_token_usage`, but only when `total_token_usage` ADVANCED
 *     since the previous line; Codex re-emits an unchanged total on some
 *     events, and counting `last` again would double-bill the turn.
 *   - otherwise fall back to the difference of the cumulative totals.
 *   - `cached_input_tokens` is a SUBSET of `input_tokens`, so billable input is
 *     `input - cached` (`rust/adapters/codex/src/report.rs:85`
 *     `non_cached_input_tokens`).
 *   - `reasoning_output_tokens` is a subset of `output_tokens` and is never
 *     billed on top of it.
 */

/**
 * Preserve distinct Sol, Terra and Luna model IDs: they have different prices.
 * Only legacy codex/spark spellings use the historical candidate ladder.
 * `codex-auto-review` has no verified catalog rate and stays unpriced.
 */
const CODEX_MODEL_SUFFIXES = ["-spark", "-codex"];

function codexPriceCandidates(model: string): string[] {
    const candidates: string[] = [];
    const push = (value: string | null): void => {
        if (value && !candidates.includes(value)) {
            candidates.push(value);
        }
    };

    push(model);
    push(stripModelVariantSuffix(model));

    let current = model;
    let peeled = true;

    while (peeled) {
        peeled = false;

        for (const suffix of CODEX_MODEL_SUFFIXES) {
            if (current.endsWith(suffix) && current.length > suffix.length) {
                current = current.slice(0, -suffix.length);
                push(current);
                peeled = true;
                break;
            }
        }
    }

    return candidates;
}

export const codexDriver: MonitorDriver = {
    id: "codex",

    roots(home: string): string[] {
        return nativeSessionRoots("codex", home);
    },

    /** One home per account (`~/.codex`, `~/.codex-work`), so each root is tagged. */
    rootsForAccounts(accounts: AccountEntry[]): DriverRoot[] {
        return spendScopeRoots({ agent: "codex", accounts });
    },

    isTranscript(name: string): boolean {
        return isNativeTranscript("codex", name);
    },

    // sessions/YYYY/MM/DD/rollout-*.jsonl
    maxDepth: nativeTranscriptMaxDepth("codex"),

    createParser: createCodexUsageParser,

    priceCandidates: codexPriceCandidates,
};
