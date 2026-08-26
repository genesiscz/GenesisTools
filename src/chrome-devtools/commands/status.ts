import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { captureDir } from "../lib/paths.ts";
import { artifactPath } from "../lib/platform.ts";
import { collectStatus } from "../lib/status.ts";
import { suggest } from "./shared.ts";

function mb(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function registerStatus(program: Command): void {
    program
        .command("status")
        .description(
            "every recorder and recorder-shaped process: pid, CPU, memory, cpu-time, buffer size, endpoint health. Read-only."
        )
        .option("--detailed", "add per-port meta, pidfile records and segment lists")
        .option("--format <fmt>", "output format: table (default) or json")
        .option("--json", "shorthand for --format json")
        .action(async (opts: { detailed?: boolean; format?: string; json?: boolean }) => {
            const report = await collectStatus();

            if (opts.json || opts.format === "json") {
                out.result(report);
                process.exit(0);
            }

            if (opts.format && opts.format !== "table") {
                out.log.error(`unknown --format '${opts.format}'. Valid: table, json.`);
                process.exit(1);
            }

            renderCliHeader("chrome-devtools status", "recorders · buffers · endpoints");

            if (report.ports.length === 0) {
                out.println("no capture dirs yet — nothing has ever recorded on this machine.");
                out.println(`  start: ${suggest(["attach"])}`);
            } else {
                const table = createBoxTable([
                    "PORT",
                    "RECORDER",
                    "CPU",
                    "MEM",
                    "CPU TIME",
                    "UP",
                    "SCOPE",
                    "CHANNELS",
                    "BUFFER",
                    "ENDPOINT",
                ]);

                for (const p of report.ports) {
                    const rec =
                        p.pidState.status === "live"
                            ? formatDotStatus("ok", `pid ${p.pidState.pid}`)
                            : p.pidState.status === "none"
                              ? formatDotStatus("dim", "none")
                              : formatDotStatus("err", p.pidState.status);
                    const scope = p.meta?.scope.allTabs ? "all-tabs" : (p.meta?.scope.match ?? "—");
                    table.push([
                        pc.white(String(p.port)),
                        rec,
                        p.sample?.cpuPercent != null ? `${p.sample.cpuPercent}%` : "—",
                        p.sample ? mb(p.sample.rssKb * 1024) : "—",
                        p.sample?.cpuTime ?? "—",
                        p.sample?.elapsed ?? "—",
                        scope,
                        p.meta?.channels.join(",") ?? "—",
                        p.segments.count ? `${mb(p.segments.bytes)} / ${p.segments.count} seg` : "empty",
                        p.endpoint
                            ? `${p.endpoint.browser.slice(0, 22)} (${p.endpoint.pages}p)`
                            : formatDotStatus("err", "no CDP"),
                    ]);
                }

                out.println(table.toString());
            }

            if (report.orphans.length > 0) {
                renderCliSection("Orphan recorder-shaped processes (no pidfile owns them)");
                const table = createBoxTable(["PID", "CPU", "UP", "COMMAND"]);
                for (const o of report.orphans) {
                    table.push([
                        pc.red(String(o.pid)),
                        o.sample?.cpuPercent != null ? `${o.sample.cpuPercent}%` : "—",
                        o.sample?.elapsed ?? "—",
                        o.command.slice(0, 90),
                    ]);
                }

                out.println(table.toString());
                out.println(`  kill safely: ${suggest(["cleanup", "--kill", "<pid>"])}`);
            }

            if (report.legacyFiles.length > 0) {
                renderCliSection("Legacy old-skill files");
                for (const f of report.legacyFiles) {
                    out.println(`  ${f}`);
                }

                out.println(`  remove: ${suggest(["cleanup", "--legacy"])}`);
            }

            if (opts.detailed) {
                for (const p of report.ports) {
                    renderCliSection(`port ${p.port} — detail`);
                    out.println(`  dir:      ${captureDir(p.port)}`);
                    out.println(
                        `  pidfile:  ${p.pidState.status}${"record" in p.pidState ? ` (${p.pidState.record.command ?? "?"})` : ""}`
                    );
                    out.println(
                        `  meta:     ${p.meta ? `started ${new Date(p.meta.startedAt).toISOString()} argv=${p.meta.argv.join(" ")}` : "—"}`
                    );
                    out.println(
                        `  segments: ${p.segments.count} (oldest ${p.segments.oldestMs ? new Date(p.segments.oldestMs).toISOString() : "—"}, newest ${p.segments.newestMs ? new Date(p.segments.newestMs).toISOString() : "—"})`
                    );
                }
            }

            renderCliSection("Legend");
            out.println(
                "  RECORDER: ● pid = alive and pidfile-owned · none = no recorder · dead/foreign = stale pidfile (doctor explains)"
            );
            out.println("  ENDPOINT: browser build + (Np) = N open page tabs · no CDP = nothing listens on that port");
            out.println("  BUFFER: total size / number of segment files (30-min rotation, 4h window)");
            out.println("  UP / CPU TIME: ps elapsed and cpu time, [[dd-]hh:]mm:ss");
            renderCliSection("Next");
            out.println(`  ${suggest(["doctor"])}                 diagnose problems (read-only)`);
            out.println(`  ${suggest(["har", "--last", "30m", "-o", artifactPath("cdp.har")])}   dump recent traffic`);
            process.exit(0);
        });
}
