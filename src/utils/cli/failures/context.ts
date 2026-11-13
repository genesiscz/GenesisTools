import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli/tools";
import { captureRuntimeFacts, type RuntimeFacts } from "@genesiscz/utils/diagnostics/runtime";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import type { ToolFailure } from "./record";

export interface FailureContext {
    version: 1;
    failureId: string;
    failureAt: string;
    preparedAt: string | null;
    runtime: { state: "captured"; facts: RuntimeFacts } | { state: "unavailable"; reason: string };
    markdown: string;
    triage?: { capturedAt: string; markdown: string };
}

const processRowSchema = z.object({
    pid: z.number(),
    name: z.string(),
    cpuPercent: z.number().nullable(),
    rssMb: z.number(),
});
const contextSchema = z.object({
    version: z.literal(1),
    failureId: z.string(),
    failureAt: z.string(),
    preparedAt: z.string().nullable(),
    runtime: z.discriminatedUnion("state", [
        z.object({ state: z.literal("unavailable"), reason: z.string() }),
        z.object({
            state: z.literal("captured"),
            facts: z.object({
                capturedAt: z.string(),
                os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
                load: z.object({ one: z.number(), five: z.number(), fifteen: z.number(), cores: z.number() }),
                memory: z.object({ totalGb: z.number(), freeGb: z.number() }),
                process: z.object({
                    pid: z.number(),
                    rss: z.number(),
                    heapTotal: z.number(),
                    heapUsed: z.number(),
                    external: z.number(),
                    arrayBuffers: z.number(),
                    cpu: z.object({ user: z.number(), system: z.number() }),
                }),
                processCount: z.number(),
                topCpu: z.array(processRowSchema),
                topMemory: z.array(processRowSchema),
                errors: z.array(z.string()),
            }),
        }),
    ]),
    markdown: z.string(),
    triage: z.object({ capturedAt: z.string(), markdown: z.string() }).optional(),
});

function contextPath(failure: ToolFailure, dir: string): string {
    const key = createHash("sha256")
        .update([failure.id, failure.at, failure.tool, failure.command].join("\n"))
        .digest("hex");
    return join(dir, "failure-contexts", `${key}.json`);
}

function prepared(failure: ToolFailure, facts: RuntimeFacts | null): FailureContext {
    const runtime: FailureContext["runtime"] = facts
        ? { state: "captured", facts }
        : { state: "unavailable", reason: "No machine snapshot is available for this failure." };
    const caller = failure.caller;
    const timeWithIso = (value: string) => `${new Date(value).toLocaleString()} (${value})`;
    const markdown = [
        `# ${failure.operation ? `${failure.operation.server}: ${failure.operation.name}` : (failure.command ?? failure.tool)} failed`,
        `Failure time: ${timeWithIso(failure.at)}`,
        `Context captured: ${facts ? timeWithIso(facts.capturedAt) : "unavailable"}`,
        `Failure id: ${failure.id}; process ${failure.pid}; exit ${failure.exitCode ?? "handled in the live process"}.`,
        `Checkout: ${failure.toolsRoot}; working directory: ${failure.cwd}.`,
        caller
            ? `Caller: ${caller.agent}; session ${caller.sessionId ?? "unknown"}; branch ${caller.branch ?? "unknown"}; commit ${caller.commitSha ?? "unknown"}.`
            : "Caller identity was not recorded.",
        caller?.transcriptPath ? `Transcript: ${caller.transcriptPath}` : "",
        failure.message ?? "The failure has no recorded message.",
        failure.stack ? ["## Stack", "```text", failure.stack, "```"].join("\n") : "",
        failure.stderrTail ? ["## Recorded output", "```text", failure.stderrTail, "```"].join("\n") : "",
        facts
            ? ["## Machine state at collection", "```json", SafeJSON.stringify(facts, null, 2), "```"].join("\n")
            : "No machine snapshot is available for this failure.",
    ]
        .filter(Boolean)
        .join("\n\n");
    return {
        version: 1,
        failureId: failure.id,
        failureAt: failure.at,
        preparedAt: facts?.capturedAt ?? null,
        runtime,
        markdown,
    };
}

/** Called after appendFailure writes its base event, including while the process is exiting. */
export function captureFailureContext(options: {
    failure: ToolFailure;
    dir: string;
    facts?: RuntimeFacts;
    fullTriage?: boolean;
}): void {
    const context = prepared(options.failure, options.facts ?? captureRuntimeFacts());
    writeContext(options.failure, options.dir, context);
    const command = [options.failure.tool, ...options.failure.argv].join(" ");
    // Diagnostics must not recursively start diagnostics if the triage itself fails.
    if (
        options.fullTriage &&
        !/^genesis-tools (?:triage|env|logs prepare)(?: |$)/.test(command) &&
        options.failure.kind !== "interrupt"
    ) {
        spawnToolDetached(["genesis-tools", "logs", "prepare", options.failure.id, "--at", options.failure.at], {
            reparent: true,
        });
    }
}

function writeContext(failure: ToolFailure, dir: string, context: FailureContext): void {
    mkdirSync(join(dir, "failure-contexts"), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(contextPath(failure, dir), SafeJSON.stringify(context), { mode: 0o600 });
}

/** Completes the event's report with the same bounded gatherer used by the app, without replacing its event-time facts. */
export function enrichFailureContext(options: {
    failure: ToolFailure;
    dir: string;
    triage: NonNullable<FailureContext["triage"]>;
}): void {
    const context = readFailureContext(options);
    const base = context.triage
        ? context.markdown.slice(0, context.markdown.lastIndexOf("\n\n## Full triage"))
        : context.markdown;
    context.triage = options.triage;
    context.markdown = `${base}\n\n## Full triage\n\nCollected at ${options.triage.capturedAt}.\n\n${options.triage.markdown}`;
    writeContext(options.failure, options.dir, context);
}

/** Reads only. A retained old v1 failure is already reportable, without manufacturing past CPU/memory values. */
export function readFailureContext(options: { failure: ToolFailure; dir: string }): FailureContext {
    try {
        const parsed = contextSchema.safeParse(
            SafeJSON.parse(readFileSync(contextPath(options.failure, options.dir), "utf8"))
        );
        if (parsed.success && parsed.data.failureId === options.failure.id) {
            return parsed.data;
        }
    } catch (error) {
        // A failure predating capture has no sidecar. Its recorded evidence remains sufficient for a report.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            const legacy = prepared(options.failure, null);
            legacy.markdown +=
                "\n\nStored machine context could not be read; the original failure evidence is preserved.";
            return legacy;
        }
    }

    return prepared(options.failure, null);
}
