import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { CodexSessionStore, deriveSessionStatus } from "../lib/store";

export async function printStatus(options: { name?: string; json?: boolean }): Promise<void> {
    const store = new CodexSessionStore();
    const names = options.name ? [options.name] : await store.listNames();
    const sessions = [];

    for (const name of names) {
        const meta = await store.readMeta(name);
        if (meta) {
            sessions.push({ ...meta, derivedStatus: deriveSessionStatus(meta) });
        }
    }

    if (options.json) {
        out.result(SafeJSON.stringify(options.name ? (sessions[0] ?? null) : sessions, null, 2));
        return;
    }

    if (sessions.length === 0) {
        out.printlnErr("No Codex sessions found.");
        return;
    }

    for (const session of sessions) {
        out.printlnErr(
            `${session.name.padEnd(24)} ${session.derivedStatus.padEnd(10)} pid=${session.daemonPid} thread=${session.threadId ?? "—"}`
        );
    }
}

export function registerStatusCommand(program: Command): void {
    program
        .command("status")
        .description("Show Codex session state")
        .option("--name <name>", "Session name; omit for all sessions")
        .option("--json", "Emit machine-readable JSON")
        .action(printStatus);
}
