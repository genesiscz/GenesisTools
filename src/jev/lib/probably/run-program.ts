import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { createProgramStore, type ProgramStore } from "./programs";
import { createProbablyProvider } from "./providers";
import { type Effect, type Options, type Provider, type Run, run } from "./runtime";

const { log } = logger.scoped("jev-probably");
const prof = profiler.scope("jev-probably");

export type ResolveInputResult = { input: string; source: "flag" | "file" | "stdin" | "json" | "empty" };

/**
 * Accepts a raw string, `@path`, `-` (stdin), a JSON object `{ "input": "…" }`,
 * or a path to a `.json`/`.txt`/plain file.
 */
export async function resolveProbablyInput(raw: string | undefined): Promise<ResolveInputResult> {
    if (raw === undefined || raw === "") {
        return { input: "", source: "empty" };
    }

    if (raw === "-") {
        if (process.stdin.isTTY) {
            throw new Error("Pipe text into stdin when using --input -.");
        }

        return { input: await Bun.stdin.text(), source: "stdin" };
    }

    if (raw.startsWith("@")) {
        const path = raw.slice(1);

        if (!path) {
            throw new Error("--input @path needs a path after @.");
        }

        return { input: await Bun.file(path).text(), source: "file" };
    }

    const looksLikePath = raw.includes("/") || raw.endsWith(".json") || raw.endsWith(".txt") || raw.endsWith(".jsonc");

    if (looksLikePath) {
        try {
            const file = Bun.file(raw);

            if (await file.exists()) {
                const text = await file.text();

                if (raw.endsWith(".json") || raw.endsWith(".jsonc")) {
                    const parsed = SafeJSON.parse(text) as unknown;

                    if (parsed && typeof parsed === "object" && "input" in parsed) {
                        const value = (parsed as { input: unknown }).input;

                        if (typeof value !== "string") {
                            throw new Error('JSON input file must have a string "input" field.');
                        }

                        return { input: value, source: "json" };
                    }
                }

                return { input: text, source: "file" };
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes('string "input"')) {
                throw error;
            }

            log.debug({ error, raw }, "treat --input as literal after path probe failed");
        }
    }

    if (raw.trimStart().startsWith("{")) {
        try {
            const parsed = SafeJSON.parse(raw) as unknown;

            if (parsed && typeof parsed === "object" && "input" in parsed) {
                const value = (parsed as { input: unknown }).input;

                if (typeof value !== "string") {
                    throw new Error('JSON --input must have a string "input" field.');
                }

                return { input: value, source: "json" };
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes('string "input"')) {
                throw error;
            }

            log.debug({ error }, "treat brace --input as literal after JSON parse failed");
        }
    }

    return { input: raw, source: "flag" };
}

export async function runStoredProgram({
    name,
    input,
    replay,
    provider,
    model,
    signal,
    onEvent,
    store = createProgramStore(),
    liveProvider,
}: {
    name: string;
    input?: string;
    replay?: Effect[];
    provider?: EvaluationProviderId;
    model?: string;
    signal?: AbortSignal;
    onEvent?: Options["onEvent"];
    store?: ProgramStore;
    liveProvider?: Provider;
}): Promise<Run> {
    const program = store.get(name);
    const options: Options = {
        input: input ?? "",
        replay,
        signal,
        onEvent,
    };
    const stop = prof.start("run");

    try {
        const result = await run(program.source, liveProvider ?? createProbablyProvider({ provider, model }), options);
        log.info(
            {
                name,
                inputChars: options.input?.length ?? 0,
                outputLines: result.output.length,
                tape: result.tape.length,
                replay: Boolean(replay),
            },
            "Probably program finished"
        );
        return result;
    } finally {
        stop();
    }
}

export async function runSource({
    source,
    input,
    replay,
    provider,
    model,
    signal,
    onEvent,
    liveProvider,
}: {
    source: string;
    input?: string;
    replay?: Effect[];
    provider?: EvaluationProviderId;
    model?: string;
    signal?: AbortSignal;
    onEvent?: Options["onEvent"];
    liveProvider?: Provider;
}): Promise<Run> {
    const stop = prof.start("run-source");

    try {
        return await run(source, liveProvider ?? createProbablyProvider({ provider, model }), {
            input: input ?? "",
            replay,
            signal,
            onEvent,
        });
    } finally {
        stop();
    }
}
