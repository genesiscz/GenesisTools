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
            "GitLab for any instance: one MR (gitlab pr <iid> review|comments|labels), many MRs (gitlab pr stale|touching), and activity per user or project"
        );

    // Set before any subcommand exists: Commander copies help settings into each one at creation.
    const defaultHelp = new Help();
    program.configureHelp({ commandUsage: (cmd) => publicUsage(cmd) ?? defaultHelp.commandUsage(cmd) });

    const pr = registerPr(program);
    const activity = program.command("activity").description("What happened on GitLab: per user, per project");
    const user = activity
        .command("user")
        .description("One user: events per local day (default), or their commits across projects (`commits`)");
    registerActivity(user);
    registerAnalyzeUser(user);
    registerAnalyzeProject(activity);

    // Every renderer reads the configured date style, so the config loads before any command runs.
    program.hook("preAction", async () => {
        await loadConfig();
    });

    return { program, pr };
}
