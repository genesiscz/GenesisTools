import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { formatStoredEventLine } from "../lib/adapter";
import { CodexSessionStore } from "../lib/store";

export async function printLogs(options: {
    name: string;
    grep?: string;
    tail?: string;
    events?: boolean;
}): Promise<void> {
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
        .action(printLogs);
}
