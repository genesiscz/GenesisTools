import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { formatEntryLine } from "@app/debugging-master/core/formatter";
import { filterByLevel, indexEntries } from "@app/debugging-master/core/log-parser";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import type { IndexedLogEntry, LogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";

interface SessionTailState {
    name: string;
    filePath: string;
    offset: number;
    entryIndex: number;
    currentFile: string;
}

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .description("Live-tail a debugging session")
        .option("-l, --level <levels>", "Filter by level(s), comma-separated")
        .option("-n <count>", "Show last N existing entries", "10")
        .action(async (opts) => {
            const globalOpts = program.opts();
            const sm = new SessionManager();
            const sessionNames = await sm.resolveSessionInteractive(globalOpts.session);
            const pretty = globalOpts.pretty ?? process.stdout.isTTY ?? false;
            const levels = opts.level?.split(",").map((l: string) => l.trim());
            const lastCount = parseInt(opts.n, 10);
            const multiSession = sessionNames.length > 1;

            const entriesBySession = new Map<string, LogEntry[]>();

            for (const sessionName of sessionNames) {
                entriesBySession.set(sessionName, await sm.readEntries(sessionName));
            }

            const allEntries: Array<IndexedLogEntry & { session: string }> = [];

            for (const [sessionName, raw] of entriesBySession) {
                let existing = indexEntries(raw);

                if (levels) {
                    existing = filterByLevel(existing, levels);
                }

                for (const entry of existing) {
                    allEntries.push({ ...entry, session: sessionName });
                }
            }

            allEntries.sort((a, b) => a.ts - b.ts);
            const tail = allEntries.slice(-lastCount);

            if (multiSession) {
                console.log(
                    `Tailing ${sessionNames.length} sessions: ${sessionNames.join(", ")} (showing last ${tail.length})`
                );
            } else {
                const raw = entriesBySession.get(sessionNames[0])!;
                console.log(`Tailing session: ${sessionNames[0]} (${raw.length} entries, showing last ${tail.length})`);
            }

            console.log("");

            const currentFiles: Record<string, string> = {};

            for (const entry of tail) {
                const prefix = multiSession ? pc.dim(`[${entry.session}] `) : "";
                const file = entry.file ?? "unknown";

                if (file !== (currentFiles[entry.session] ?? "")) {
                    currentFiles[entry.session] = file;
                    console.log(`${prefix}File: ${file}`);
                }

                console.log(`${prefix}${formatEntryLine(entry, pretty)}`);
            }

            console.log("");
            console.log("--- Watching for new entries (Ctrl+C to stop) ---");

            const states: SessionTailState[] = [];

            for (const sessionName of sessionNames) {
                const filePath = await sm.getSessionPath(sessionName);
                const raw = entriesBySession.get(sessionName)!;
                let offset = 0;

                try {
                    offset = statSync(filePath).size;
                } catch {
                    // File might not exist yet
                }

                states.push({
                    name: sessionName,
                    filePath,
                    offset,
                    entryIndex: raw.length,
                    currentFile: currentFiles[sessionName] ?? "",
                });
            }

            const watchers: FSWatcher[] = [];

            for (const state of states) {
                const processNewData = () => {
                    try {
                        const currentSize = statSync(state.filePath).size;

                        if (currentSize < state.offset) {
                            state.offset = 0;
                        }

                        if (currentSize <= state.offset) {
                            return;
                        }

                        const buffer = readFileSync(state.filePath);
                        const newBytes = buffer.subarray(state.offset, currentSize);
                        state.offset = currentSize;

                        const text = new TextDecoder().decode(newBytes);
                        const lines = text.split("\n").filter(Boolean);
                        const prefix = multiSession ? pc.dim(`[${state.name}] `) : "";

                        for (const line of lines) {
                            state.entryIndex++;

                            try {
                                const entry = SafeJSON.parse(line, { strict: true }) as LogEntry;
                                const indexed: IndexedLogEntry = { ...entry, index: state.entryIndex };

                                if (levels && !levels.includes(entry.level) && entry.level !== "raw") {
                                    continue;
                                }

                                const file = indexed.file ?? "unknown";

                                if (file !== state.currentFile) {
                                    state.currentFile = file;
                                    console.log(`${prefix}File: ${file}`);
                                }

                                console.log(`${prefix}${formatEntryLine(indexed, pretty)}`);
                            } catch {
                                const fallback: IndexedLogEntry = {
                                    level: "raw",
                                    msg: line,
                                    ts: Date.now(),
                                    index: state.entryIndex,
                                };
                                console.log(`${prefix}${formatEntryLine(fallback, pretty)}`);
                            }
                        }
                    } catch {
                        // Ignore read errors during watch
                    }
                };

                const watcher = watch(state.filePath, () => {
                    processNewData();
                });
                watchers.push(watcher);
            }

            process.on("SIGINT", () => {
                for (const watcher of watchers) {
                    watcher.close();
                }

                console.log("\nStopped tailing.");
                process.exit(0);
            });

            await new Promise(() => {}); // Keep running
        });
}
