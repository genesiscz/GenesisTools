import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { environmentMarkdown, issueEnvironmentValues, readBugTemplate } from "../lib/environment";
import { gatherTriage, triageDocument, triageMarkdown } from "../lib/triage";

/**
 * `tools genesis-tools triage`: what an agent needs to judge a failure on this Mac, in one place. The build facts of
 * `env`, and the state of the Mac at this moment: load, memory pressure, the processes that use the most CPU and
 * memory, whether the hub server answers, the app faces, the commands that failed in the last 30 minutes, the slow or
 * lost calls at the end of app-perf.log, crash reports and free disk. The app's failure notice reads `--json` for
 * "Copy context for agents" and "Draft an issue". Reads only, and every part has its own deadline: it answers on a
 * Mac that is too busy for one of them.
 */
export function registerTriageCommand(program: Command): void {
    program
        .command("triage")
        .description(
            "The build facts and the state of this Mac right now (load, top CPU, hub server, recent failures), for a bug report"
        )
        .option("--json", "Print the facts and their markdown as JSON, in the shape `env --json` has, plus `triage`")
        .action(async (options: { json?: boolean }) => {
            const report = await gatherTriage();

            if (options.json) {
                const environment = report.environment.ok ? report.environment.value : null;
                const template = readBugTemplate();
                const values = environment ? issueEnvironmentValues(environment) : {};
                // The bug form has no field for the Mac's state: it goes under the app build, the nearest one.
                const state = triageMarkdown(report);
                out.result({
                    ...(environment ?? {}),
                    markdown: triageDocument(report),
                    environmentMarkdown: environment ? environmentMarkdown(environment) : null,
                    issue: {
                        ...template,
                        values: { ...values, "app-build": [values["app-build"], state].filter(Boolean).join("\n\n") },
                    },
                    triage: report,
                });
                return;
            }

            out.println(triageDocument(report));
        });
}
