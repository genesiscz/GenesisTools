import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { diagnose } from "../lib/doctor.ts";
import { suggest } from "./shared.ts";

export function registerDoctor(program: Command): void {
    program
        .command("doctor")
        .description(
            "diagnose stale pidfiles, orphan recorders, legacy old-skill leftovers, hot processes, and broken debug flags. READ-ONLY: prints fixes, applies nothing."
        )
        .option("--json", "machine-readable findings")
        .action(async (opts: { json?: boolean }) => {
            const findings = await diagnose();

            if (opts.json) {
                out.result(findings);
                process.exit(findings.some((f) => f.severity === "err") ? 1 : 0);
            }

            if (findings.length === 0) {
                out.log.success("clean: no stale pidfiles, no orphans, no legacy leftovers, no hot recorders.");
                process.exit(0);
            }

            for (const f of findings) {
                const mark = f.severity === "err" ? pc.red("✗") : f.severity === "warn" ? pc.yellow("!") : pc.dim("·");
                out.println(`${mark} ${f.title}`);
                out.println(`    ${f.detail}`);
                if (f.fix) {
                    out.println(`    fix: ${f.fix}`);
                }
            }

            out.println("");
            out.println(`apply fixes interactively: ${suggest(["cleanup"])}`);
            process.exit(findings.some((f) => f.severity === "err") ? 1 : 0);
        });
}
