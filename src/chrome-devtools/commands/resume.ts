import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { connectBrowser } from "../lib/recorder.ts";
import { RESUME_DEFAULT_TARGET_MS, type ResumeRecord, runResume } from "../lib/resume.ts";
import { portOf, positiveNumber, withPort } from "./shared.ts";

interface ResumeCliOpts {
    port?: string;
    match?: string;
    workers?: boolean;
    debugger?: boolean;
    timeoutMs?: string;
    json?: boolean;
}

function describe(r: ResumeRecord): string {
    const url = r.urlAfter && r.urlAfter !== r.url ? `${r.url || '""'} -> ${r.urlAfter}` : r.url || '""';
    const label =
        r.outcome === "timeout"
            ? pc.red(`timeout ${r.step ?? ""}`.trim())
            : r.outcome === "error"
              ? pc.red(`error ${r.message ?? ""}`.trim())
              : r.outcome === "ok"
                ? pc.dim("ok")
                : pc.green(r.outcome);

    return `${label}  ${r.type}  ${url}`;
}

export function registerResume(program: Command): void {
    withPort(
        program
            .command("resume")
            .description(
                'release tabs a debugger client left held (a popup stuck blank, its opener showing "Debugger paused in another tab"). Sends only resume commands; never evaluates or opens tabs.'
            )
    )
        .option(
            "--match <substr>",
            "only targets whose URL contains this substring, or /regex/ (plus the blank popups they opened)"
        )
        .option("--workers", "also release workers, service workers and shared workers")
        .option("--debugger", "also end a real Debugger pause (enables Debugger on each target for ~300 ms)")
        .option("--timeout-ms <n>", "deadline per target", String(RESUME_DEFAULT_TARGET_MS))
        .option("--json", "one record per target")
        .action(async (opts: ResumeCliOpts) => {
            const port = portOf(opts);
            const perTargetMs = positiveNumber(opts.timeoutMs, RESUME_DEFAULT_TARGET_MS, "--timeout-ms");
            const conn = await connectBrowser(port);

            try {
                const report = await runResume({
                    conn,
                    match: opts.match,
                    workers: opts.workers,
                    debugger: opts.debugger,
                    perTargetMs,
                });

                if (opts.json) {
                    out.result(report);
                } else if (report.records.length === 0) {
                    out.log.info("no matching targets.");
                } else {
                    for (const r of report.records) {
                        out.println(describe(r));
                    }
                }

                process.exitCode = report.timedOut ? 1 : 0;
            } finally {
                conn.close();
            }
        });
}
