import { runTranscriptDoor } from "@genesiscz/utils/ai/transcripts/door";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { formatStoredEventLine } from "../lib/adapter";
import { CodexSessionStore } from "../lib/store";

export interface LogsOptions {
    name: string;
    grep?: string;
    tail?: string;
    events?: boolean;
    format?: string | boolean;
    thoughts?: string | boolean;
}

/** The shared transcript door for a codex session; `follow` keeps going until the session closes. */
export async function printTranscript(options: LogsOptions, follow: boolean, subcommand: string): Promise<void> {
    const store = new CodexSessionStore();
    await runTranscriptDoor({
        tool: `tools codex ${subcommand}`,
        subcommand: [subcommand],
        provider: "codex",
        query: options.name,
        format: options.format,
        thoughts: options.thoughts,
        follow,
        stillRunning: async () => {
            const meta = await store.readMeta(options.name);
            return meta !== null && meta !== undefined && meta.status !== "closed" && meta.status !== "failed";
        },
    });
}

export async function printLogs(options: LogsOptions): Promise<void> {
    if (options.format !== undefined) {
        await printTranscript(options, false, "logs");
        return;
    }

    const store = new CodexSessionStore();
    let events = await store.readEvents(options.name);
    if (options.grep) {
        const pattern = new RegExp(options.grep);
        events = events.filter((event) => pattern.test(SafeJSON.stringify(event, { strict: true })));
    }

    if (options.tail) {
        const count = Number.parseInt(options.tail, 10);
        events = events.slice(-count);
    }

    if (options.events) {
        for (const raw of events) {
            const line = formatStoredEventLine(raw);
            if (line) {
                out.println(line);
            }
        }

        return;
    }

    const body = events.map((event) => SafeJSON.stringify(event, { jsonl: true })).join("\n");
    if (body) {
        out.print(`${body}\n`);
    }
}

export function registerLogsCommand(program: Command): void {
    program
        .command("logs")
        .description("Read a Codex session event log")
        .requiredOption("--name <name>", "Session name")
        .option("--grep <pattern>", "Filter serialized events with a regular expression")
        .option("--tail <count>", "Show the last N events")
        .option("--events", "Print normalized worker events instead of raw notifications")
        .option("--format [value]", `render the session as a transcript: ${TRANSCRIPT_FORMATS.join(" | ")}`)
        .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
        .action(printLogs);
}
