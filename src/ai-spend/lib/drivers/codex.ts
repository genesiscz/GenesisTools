import { join } from "node:path";
import { stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CreateParserOptions, DriverLineParser, DriverUsageEvent, MonitorDriver } from "./types";

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

interface CodexRawUsage {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
}

interface CodexInfo {
    model?: string;
    last_token_usage?: CodexRawUsage;
    total_token_usage?: CodexRawUsage;
}

interface CodexPayload {
    type?: string;
    model?: string;
    info?: CodexInfo;
}

interface CodexLine {
    type?: string;
    timestamp?: string;
    payload?: CodexPayload;
}

interface CodexState {
    /** Sticky model from the last `turn_context` line. */
    model?: string;
    /** Last cumulative `total_token_usage`, for the diff fallback. */
    totals?: CodexRawUsage;
}

function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readState(state: unknown): CodexState {
    if (!isRecord(state)) {
        return {};
    }

    const model = typeof state.model === "string" ? state.model : undefined;
    const totals = isRecord(state.totals) ? (state.totals as CodexRawUsage) : undefined;

    return { model, totals };
}

function sameTotals(a: CodexRawUsage | undefined, b: CodexRawUsage | undefined): boolean {
    if (!a || !b) {
        return false;
    }

    return (
        num(a.input_tokens) === num(b.input_tokens) &&
        num(a.cached_input_tokens) === num(b.cached_input_tokens) &&
        num(a.output_tokens) === num(b.output_tokens) &&
        num(a.reasoning_output_tokens) === num(b.reasoning_output_tokens) &&
        num(a.total_tokens) === num(b.total_tokens)
    );
}

function subtractTotals(current: CodexRawUsage, previous: CodexRawUsage | undefined): CodexRawUsage {
    const sub = (a: number | undefined, b: number | undefined): number => Math.max(0, num(a) - num(b));

    return {
        input_tokens: sub(current.input_tokens, previous?.input_tokens),
        cached_input_tokens: sub(current.cached_input_tokens, previous?.cached_input_tokens),
        output_tokens: sub(current.output_tokens, previous?.output_tokens),
        reasoning_output_tokens: sub(current.reasoning_output_tokens, previous?.reasoning_output_tokens),
        total_tokens: sub(current.total_tokens, previous?.total_tokens),
    };
}

/**
 * Codex ships plan-specific and task-specific variants of the base OpenAI
 * models (`gpt-5.6-sol`, `gpt-5-codex`, `gpt-5.3-codex-spark`). The catalog
 * only carries the base ids with rates, so peel one known suffix at a time and
 * retry. `codex-auto-review` peels to nothing and stays unpriced.
 */
const CODEX_MODEL_SUFFIXES = ["-spark", "-codex", "-sol", "-terra", "-luna"];

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

function codexHomes(home: string): string[] {
    const override = env.codex.getHomeOverride();

    if (override) {
        const homes = override
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path.length > 0);

        if (homes.length > 0) {
            return homes;
        }
    }

    return [join(home, ".codex")];
}

export const codexDriver: MonitorDriver = {
    id: "codex",

    roots(home: string): string[] {
        const roots: string[] = [];

        for (const codexHome of codexHomes(home)) {
            for (const dir of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
                if (!roots.includes(dir)) {
                    roots.push(dir);
                }
            }
        }

        return roots;
    },

    isTranscript(name: string): boolean {
        return name.endsWith(".jsonl");
    },

    // sessions/YYYY/MM/DD/rollout-*.jsonl
    maxDepth: 4,

    createParser(options: CreateParserOptions): DriverLineParser {
        const state = readState(options.state);

        return {
            parseLine(line: string, emit: (event: DriverUsageEvent) => void): void {
                const trimmed = line.trim();

                if (!trimmed) {
                    return;
                }

                let parsed: unknown;
                try {
                    parsed = SafeJSON.parse(trimmed, { strict: true });
                } catch (err) {
                    logger.debug({ err }, "ai-spend codex: skipping malformed rollout line");

                    return;
                }

                if (!isRecord(parsed)) {
                    return;
                }

                const raw = parsed as CodexLine;

                if (raw.type === "turn_context") {
                    const model = raw.payload?.model;

                    if (typeof model === "string" && model.length > 0) {
                        state.model = model;
                    }

                    return;
                }

                if (raw.type !== "event_msg" || raw.payload?.type !== "token_count") {
                    return;
                }

                const info = raw.payload.info;
                const totals = info?.total_token_usage;
                // Codex re-emits the same cumulative total on some events; when it
                // has NOT advanced, `last_token_usage` is a repeat of a turn that
                // was already counted.
                const advanced = !totals || !sameTotals(totals, state.totals);
                const last = advanced ? info?.last_token_usage : undefined;
                const usage = last ?? (totals ? subtractTotals(totals, state.totals) : undefined);

                if (totals) {
                    state.totals = totals;
                }

                if (!usage) {
                    return;
                }

                const inputTotal = num(usage.input_tokens);
                const cached = Math.min(num(usage.cached_input_tokens), inputTotal);
                const output = num(usage.output_tokens);
                const reasoning = num(usage.reasoning_output_tokens);

                if (inputTotal === 0 && cached === 0 && output === 0 && reasoning === 0) {
                    return;
                }

                const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
                const model = raw.payload.model ?? info?.model ?? state.model ?? "unknown";
                const inputTokens = inputTotal - cached;

                emit({
                    id: `${timestamp}|${model}|${inputTokens}|${cached}|${output}`,
                    model,
                    timestamp,
                    inputTokens,
                    outputTokens: output,
                    cacheCreationTokens: 0,
                    cacheReadTokens: cached,
                });
            },
            snapshot(): unknown {
                return state;
            },
        };
    },

    priceCandidates: codexPriceCandidates,
};
