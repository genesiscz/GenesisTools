import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    actionsFromFindings,
    clearStalePidfile,
    killRecorderPid,
    moveCaptureDir,
    moveLegacyFiles,
    partitionForYes,
} from "../lib/cleanup.ts";
import { diagnose } from "../lib/doctor.ts";
import { suggest } from "./shared.ts";

interface CleanupOpts {
    kill?: string[];
    stale?: string[];
    legacy?: boolean | string[];
    dir?: string[];
    yes?: boolean;
}

export function registerCleanup(program: Command): void {
    program
        .command("cleanup")
        .description(
            "apply the fixes doctor found: kill orphans, clear stale pidfiles, move legacy files and dead buffers to a /tmp trash dir. Interactive in a terminal; explicit flags otherwise."
        )
        .option(
            "--kill <pid...>",
            "SIGTERM these recorder pids (refuses recycled pids, live recorders, and launcher ancestors of live recorders)"
        )
        .option("--stale <port...>", "clear dead/foreign recorder pidfiles for these ports")
        .option("--legacy [port...]", "move legacy /tmp/cdp-arm-* files to trash (all, or only the given ports')")
        .option("--dir <port...>", "move these ports' capture dirs to trash (the buffer is gone from har afterwards)")
        .option("--yes", "apply all SAFE fixes without confirmation — never kills anything")
        .addHelpText(
            "after",
            `
Nothing is destroyed in place: files are MOVED to /tmp/GenesisTools/ChromeDevtools/trash-<date>/
and survive until reboot. Run 'doctor' first to see what needs cleaning.`
        )
        .action(async (opts: CleanupOpts) => {
            const explicit = Boolean(opts.kill?.length || opts.stale?.length || opts.legacy || opts.dir?.length);

            if (explicit) {
                const results = await Promise.all([
                    ...(opts.kill ?? []).map((pid) => killRecorderPid(Number(pid))),
                    ...(opts.stale ?? []).map((port) => clearStalePidfile(Number(port))),
                    ...(opts.legacy
                        ? [moveLegacyFiles(Array.isArray(opts.legacy) ? opts.legacy.map(Number) : undefined)]
                        : []),
                    ...(opts.dir ?? []).map((port) => moveCaptureDir(Number(port))),
                ]);

                let failed = 0;
                for (const r of results) {
                    if (r.ok) {
                        out.log.success(r.message);
                    } else {
                        out.log.error(r.message);
                        failed++;
                    }
                }

                process.exit(failed ? 1 : 0);
            }

            const findings = await diagnose();
            const actions = actionsFromFindings(findings);

            if (actions.length === 0) {
                out.log.success("nothing to clean.");
                process.exit(0);
            }

            const { batchable: safeActions, excludedKills: killActions } = partitionForYes(actions);

            if (!isInteractive() && !opts.yes) {
                out.log.error("cleanup needs a terminal (or explicit flags). Findings and their commands:");
                for (const f of findings) {
                    out.log.info(`  ${f.title}${f.fix ? `\n    ${f.fix}` : ""}`);
                }

                if (safeActions.length > 0) {
                    out.log.info(`  all SAFE fixes at once (never kills anything): ${suggest(["cleanup", "--yes"])}`);
                }

                if (killActions.length > 0) {
                    out.log.warn(
                        "  kills are never batched — run each 'cleanup --kill <pid>' deliberately after checking 'status'."
                    );
                }

                process.exit(1);
            }

            let chosen = actions;
            if (opts.yes) {
                chosen = safeActions;
                for (const kill of killActions) {
                    out.log.warn(
                        `skipped (kills are never batched): ${kill.label} — run its cleanup --kill explicitly`
                    );
                }

                if (chosen.length === 0) {
                    out.log.info("nothing safe to batch; only kill actions remain and those need explicit --kill.");
                    process.exit(0);
                }
            }

            if (!opts.yes) {
                const picked = await p.multiselect({
                    message: "What should be cleaned? (space toggles, enter confirms)",
                    options: actions.map((a, i) => ({ value: i, label: a.label })),
                    required: false,
                });

                if (p.isCancel(picked) || (Array.isArray(picked) && picked.length === 0)) {
                    p.cancel("nothing cleaned");
                    process.exit(0);
                }

                chosen = (picked as number[]).map((i) => actions[i]);
            }

            let failed = 0;
            for (const action of chosen) {
                const r = await action.apply();
                if (r.ok) {
                    out.log.success(r.message);
                } else {
                    out.log.error(r.message);
                    failed++;
                }
            }

            process.exit(failed ? 1 : 0);
        });
}
