import { registerActivity } from "@app/gitlab/commands/activity";
import { registerAnalyzeProject } from "@app/gitlab/commands/analyze-project";
import { registerAnalyzeUser } from "@app/gitlab/commands/analyze-user";
import { publicUsage, registerPr } from "@app/gitlab/commands/pr";
import { loadConfig } from "@app/gitlab/lib/config";
import { Command, Help } from "commander";

/** The whole `gitlab` command tree; the entrypoint runs it, tests walk it. */
export function buildProgram(): { program: Command; pr: Command } {
    const program = new Command();

    program
        .name("gitlab")
        .description(
            "GitLab for any instance: one MR (gitlab pr <iid> review|comments|labels), many MRs (gitlab pr stale|touching), and user and project activity"
        );

    // Set before any subcommand exists: Commander copies help settings into each one at creation.
    const defaultHelp = new Help();
    program.configureHelp({ commandUsage: (cmd) => publicUsage(cmd) ?? defaultHelp.commandUsage(cmd) });

    const pr = registerPr(program);
    const user = program.command("user").description("A GitLab user: per-day activity, commit history");
    registerActivity(user);
    registerAnalyzeUser(user);
    const project = program.command("project").description("A GitLab project: commit activity per month");
    registerAnalyzeProject(project);

    // Every renderer reads the configured date style, so the config loads before any command runs.
    program.hook("preAction", async () => {
        await loadConfig();
    });

    return { program, pr };
}
