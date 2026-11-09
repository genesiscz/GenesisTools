import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { environmentMarkdown, gatherEnvironment, issueEnvironmentValues, readBugTemplate } from "../lib/environment";

/**
 * `tools genesis-tools env`: the environment an issue or an agent needs (build commit and age, branch, dirty, build
 * time, the tools checkout, Bun, macOS, chip, the recorder's grants and processes). The app's failure notice reads
 * `--json` and puts its `markdown` into "Copy context for agents" and "Draft an issue". Reads only.
 */
export function registerEnvCommand(program: Command): void {
    program
        .command("env")
        .description("The environment an issue report needs: build, checkout, Bun, macOS, chip, grants, recorder")
        .option("--json", "Print the facts and their markdown section as JSON")
        .action((options: { json?: boolean }) => {
            const report = gatherEnvironment();
            const markdown = environmentMarkdown(report);

            if (options.json) {
                // `issue`: the bug form's fields in order and the environment answers by field id, so a drafted issue
                // has the form's sections with its exact names.
                const template = readBugTemplate();
                out.result({ ...report, markdown, issue: { ...template, values: issueEnvironmentValues(report) } });
                return;
            }

            out.println(markdown);
        });
}
