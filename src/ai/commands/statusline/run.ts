#!/usr/bin/env bun
/**
 * The hot entry: what the host runs on every statusline render.
 *
 * Deliberately not routed through `tools ai`: that launcher imports the whole `src/ai` command
 * tree and two preloads before it can answer, and a statusline is rendered about every six
 * seconds in every session on the machine. This file imports the renderer and one host feature
 * and nothing else. `tools ai statusline run` is the same code behind the ordinary door.
 */
import { claudeCodeStatusline } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/statusline";
import { loadStatuslineConfig } from "@genesiscz/utils/ai/statusline/config";
import { renderStatusline } from "@genesiscz/utils/ai/statusline/render";
import type { StatuslineFeature } from "@genesiscz/utils/ai/statusline/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";

export type StatuslineHost = "claude" | "codex" | "grok";

export interface RunStatuslineOptions {
    host: StatuslineHost;
    /** Read the payload from this file instead of stdin. */
    stdinFile?: string;
    columns?: number;
    /** Print per-step timings to stderr after the lines. */
    timings?: boolean;
    /** Override the feature (tests, previews). */
    feature?: StatuslineFeature;
    /** Override the raw document (previews). */
    raw?: Record<string, unknown>;
}

/** The host feature for a host, or null when that host has no statusline hook yet. */
export function featureFor(host: StatuslineHost): StatuslineFeature | null {
    return host === "claude" ? claudeCodeStatusline() : null;
}

/** Render once and return the lines; the caller decides how to print and when to exit. */
export async function runStatusline(
    options: RunStatuslineOptions
): Promise<{ lines: string[]; settled: Promise<void> }> {
    const feature = options.feature ?? featureFor(options.host);

    if (!feature) {
        throw new Error(`${options.host} has no statusline hook yet; only Claude Code renders one today`);
    }

    const raw = options.raw ?? (await readPayload(options.stdinFile));
    const config = await loadStatuslineConfig();
    const result = await renderStatusline(raw, {
        feature,
        config,
        ...(options.columns === undefined ? {} : { columns: options.columns }),
    });

    if (options.timings) {
        const parts = Object.entries(result.timings).map(([step, ms]) => `${step}=${ms}ms`);
        out.log.info(`statusline timings: ${parts.join(" ")}`);
    }

    return { lines: result.lines, settled: result.settled };
}

async function readPayload(stdinFile?: string): Promise<Record<string, unknown>> {
    const text = stdinFile ? await Bun.file(stdinFile).text() : await Bun.stdin.text();
    const parsed = SafeJSON.parse(text, { strict: true });

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("the statusline payload must be one JSON object on stdin");
    }

    return parsed as Record<string, unknown>;
}

function parseHostArgs(argv: string[]): RunStatuslineOptions {
    let host: StatuslineHost = "claude";
    let stdinFile: string | undefined;
    let columns: number | undefined;
    let timings = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--claude" || arg === "--codex" || arg === "--grok") {
            host = arg.slice(2) as StatuslineHost;
        } else if (arg === "--stdin-file") {
            stdinFile = argv[++i];
        } else if (arg === "--columns") {
            columns = Number.parseInt(argv[++i] ?? "", 10);
        } else if (arg === "--timings") {
            timings = true;
        }
    }

    return {
        host,
        ...(stdinFile === undefined ? {} : { stdinFile }),
        ...(columns === undefined || Number.isNaN(columns) ? {} : { columns }),
        timings,
    };
}

if (import.meta.main) {
    const options = parseHostArgs(Bun.argv.slice(2));

    try {
        const { lines, settled } = await runStatusline(options);
        out.print(lines.join("\n"));
        await settled;
        process.exit(0);
    } catch (error) {
        logger.error({ err: error }, "statusline render failed");
        process.exit(1);
    }
}
