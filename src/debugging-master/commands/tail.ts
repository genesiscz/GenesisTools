import { readFileSync, statSync, watch } from "node:fs";
import { formatEntryLine } from "@app/debugging-master/core/formatter";
import { filterByLevel, indexEntries } from "@app/debugging-master/core/log-parser";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import type { IndexedLogEntry, LogEntry } from "@app/debugging-master/types";
import type { Command } from "commander";

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .description("Live-tail a debugging session")
        .option("-l, --level <levels>", "Filter by level(s), comma-separated")
        .option("-n <count>", "Show last N existing entries", "10")
        .action(async (opts) => {
            const globalOpts = program.opts();
            const sm = new SessionManager();
            const sessionName = await sm.resolveSession(globalOpts.session);
            const filePath = await sm.getSessionPath(sessionName);
            const pretty = globalOpts.pretty ?? process.stdout.isTTY ?? false;
            const levels = opts.level?.split(",").map((l: string) => l.trim());
            const lastCount = parseInt(opts.n, 10);

            const raw = await sm.readEntries(sessionName);
            let existing = indexEntries(raw);
            if (levels) existing = filterByLevel(existing, levels);
            const tail = existing.slice(-lastCount);

            console.log(`Tailing session: ${sessionName} (${raw.length} entries, showing last ${tail.length})`);
            console.log("");

            let currentFile = "";
            for (const entry of tail) {
                const file = entry.file ?? "unknown";
                if (file !== currentFile) {
                    currentFile = file;
                    console.log(`File: ${file}`);
                }
                console.log(formatEntryLine(entry, pretty));
            }

            console.log("");
            console.log("--- Watching for new entries (Ctrl+C to stop) ---");

            let offset = 0;
            try {
                offset = statSync(filePath).size;
            } catch {
                // File might not exist yet
            }

            let entryIndex = raw.length;

            const processNewData = () => {
                try {
                    const currentSize = statSync(filePath).size;
                    if (currentSize < offset) {
                        offset = 0;
                    }
                    if (currentSize <= offset) return;

                    const buffer = readFileSync(filePath);
                    const newBytes = buffer.subarray(offset, currentSize);
                    offset = currentSize;

                    const text = new TextDecoder().decode(newBytes);
                    const lines = text.split("\n").filter(Boolean);

                    for (const line of lines) {
                        entryIndex++;
                        try {
                            const entry = JSON.parse(line) as LogEntry;
                            const indexed: IndexedLogEntry = { ...entry, index: entryIndex };

                            if (levels && !levels.includes(entry.level) && entry.level !== "raw") continue;

                            const file = indexed.file ?? "unknown";
                            if (file !== currentFile) {
                                currentFile = file;
                                console.log(`File: ${file}`);
                            }
                            console.log(formatEntryLine(indexed, pretty));
                        } catch {
                            const fallback: IndexedLogEntry = {
                                level: "raw",
                                msg: line,
                                ts: Date.now(),
                                index: entryIndex,
                            };
                            console.log(formatEntryLine(fallback, pretty));
                        }
                    }
                } catch {
                    // Ignore read errors during watch
                }
            };

            const watcher = watch(filePath, () => {
                processNewData();
            });

            process.on("SIGINT", () => {
                watcher.close();
                console.log("\nStopped tailing.");
                process.exit(0);
            });

            await new Promise(() => {}); // Keep running
        });
}
