import { out } from "@genesiscz/utils/logger";
import { shortenHomePaths } from "@genesiscz/utils/paths";
import type { Command } from "commander";
import { environmentMarkdown, gatherEnvironment, issueEnvironmentValues, shortenedIssue } from "../lib/environment";

/**
 * `tools genesis-tools env`: the environment an issue or an agent needs (build commit and age, branch, dirty, build
 * time, the tools checkout, Bun, macOS, chip, the recorder's grants and processes). `tools genesis-tools triage` adds
 * the state of the Mac at this moment and answers `--json` in the same shape; the app's failure notice reads that one
 * for "Copy context for agents" and "Draft an issue", and this one from a checkout that has no `triage`. Reads only.
 */
export function registerEnvCommand(program: Command): void {
    program
        .command("env")
        .description("The environment an issue report needs: build, checkout, Bun, macOS, chip, grants, recorder")
        .option("--json", "Print the facts and their markdown section as JSON")
        .action((options: { json?: boolean }) => {
            const report = gatherEnvironment();
            const markdown = shortenHomePaths(environmentMarkdown(report));

            if (options.json) {
                // `issue`: the bug form's fields in order and the environment answers by field id, so a drafted issue
                // has the form's sections with its exact names.
                out.result({ ...report, markdown, issue: shortenedIssue(issueEnvironmentValues(report)) });
                return;
            }

            out.println(markdown);
        });
}
