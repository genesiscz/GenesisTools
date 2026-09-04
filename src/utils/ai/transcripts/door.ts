import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { transcriptEnvelope } from "./load";
import {
    defaultRenderContext,
    isThoughtMode,
    isTranscriptFormat,
    rendererFor,
    THOUGHT_MODES,
    type ThoughtMode,
    TRANSCRIPT_FORMATS,
    type TranscriptFormat,
} from "./render";
import { type ResolvedTranscript, resolveTranscript } from "./resolve";
import { followTranscript } from "./tail";
import type { SliceOptions, TranscriptProvider } from "./types";

/**
 * An enumerated flag declared `--flag [value]`: absent → the default; bare in a
 * TTY → a picker; bare elsewhere, or an unknown value → the possible values and
 * a filled-in command line, exit 1 (CLAUDE.md "Enumerated flags").
 */
export async function pickEnumFlag<T extends string>(input: {
    tool: string;
    subcommand: string[];
    flag: string;
    given: string | boolean | undefined;
    values: readonly T[];
    fallback: T;
    accepts: (value: string) => value is T;
}): Promise<T | null> {
    const { flag, given, values, fallback, accepts } = input;
    if (given === undefined || given === false) {
        return fallback;
    }

    if (typeof given === "string" && accepts(given)) {
        return given;
    }

    if (given === true && isInteractive()) {
        const picked = String(
            await p.select({
                message: `${flag} value`,
                options: values.map((value) => ({ value, label: value })),
            })
        );
        return accepts(picked) ? picked : null;
    }

    out.printlnErr(
        suggestEnumFlag(input.tool, flag, values, {
            subcommand: input.subcommand,
            given: typeof given === "string" ? given : undefined,
        })
    );
    process.exitCode = 1;
    return null;
}

export interface TranscriptDoorOptions {
    /** For the enum-flag help line, e.g. "tools grok" + ["read"]. */
    tool: string;
    subcommand: string[];
    provider?: TranscriptProvider;
    /** Worker name or session id. */
    query: string;
    format?: string | boolean;
    thoughts?: string | boolean;
    /** Legacy aliases: `--events` and `--json`. An explicit `--format` wins. */
    events?: boolean;
    json?: boolean;
    slice?: SliceOptions;
    /** Pin one turn file instead of the resolver's latest-plus-earlier chain. */
    turnFile?: string;
    follow?: boolean;
    /**
     * Follow mode also stops when this reports false (the worker process is
     * gone), polled every two seconds, or as soon as an envelope is terminated.
     */
    stillRunning?: () => Promise<boolean>;
}

const RUNNING_POLL_MS = 2000;

/**
 * The one door every backend's read/tail/logs verb goes through: resolve the
 * transcript, pick the renderer, dump or follow. No backend formats a transcript
 * itself.
 */
export async function runTranscriptDoor(options: TranscriptDoorOptions): Promise<void> {
    const format = await pickEnumFlag<TranscriptFormat>({
        tool: options.tool,
        subcommand: options.subcommand,
        flag: "--format",
        given: options.format,
        values: TRANSCRIPT_FORMATS,
        fallback: options.events ? "events" : options.json ? "json" : "compact",
        accepts: isTranscriptFormat,
    });
    const thoughts = await pickEnumFlag<ThoughtMode>({
        tool: options.tool,
        subcommand: options.subcommand,
        flag: "--thoughts",
        given: options.thoughts,
        values: THOUGHT_MODES,
        fallback: "short",
        accepts: isThoughtMode,
    });
    if (format === null || thoughts === null) {
        return;
    }

    const follow = options.follow === true;
    const renderer = rendererFor(format);
    const ctx = defaultRenderContext({ thoughts, follow });

    try {
        // A pinned turn file needs no discovery: the caller already knows the
        // backend, the session and the file.
        const resolved: ResolvedTranscript =
            options.turnFile && options.provider
                ? {
                      provider: options.provider,
                      sessionId: options.query,
                      source: "worker",
                      filePath: options.turnFile,
                      extraFiles: [],
                  }
                : await resolveTranscript(options.query, {}, options.provider);

        renderer.open(ctx);

        if (!follow) {
            renderer.envelope(await transcriptEnvelope(resolved, options.slice), ctx);
            renderer.close(ctx);
            return;
        }

        const ac = new AbortController();
        process.once("SIGINT", () => ac.abort());
        const poll = options.stillRunning
            ? setInterval(() => {
                  options
                      .stillRunning?.()
                      .then((running) => {
                          if (!running) {
                              ac.abort();
                          }
                      })
                      .catch(() => {
                          // A failed process probe is not a reason to stop following.
                      });
              }, RUNNING_POLL_MS)
            : null;

        try {
            await followTranscript(resolved, {
                slice: options.slice,
                signal: ac.signal,
                onEnvelope: (envelope) => {
                    renderer.envelope(envelope, ctx);
                    if (envelope.terminated) {
                        ac.abort();
                    }
                },
            });
        } finally {
            if (poll) {
                clearInterval(poll);
            }
        }

        renderer.close(ctx);
    } catch (error) {
        process.exitCode = 1;
        out.printlnErr(error instanceof Error ? error.message : String(error));
    }
}
