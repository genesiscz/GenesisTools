import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { CodexSessionStore } from "../lib/store";

export async function printLogs(options: { name: string; grep?: string; tail?: string }): Promise<void> {
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
        .action(printLogs);
}
