import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import {
    buildDigest,
    digestConfigPath,
    digestDay,
    digestMarkdown,
    exportDigest,
    readDigestConfig,
    writeDigestConfig,
} from "../lib/digest";

export function registerDigestCommand(program: Command): void {
    const digest = program
        .command("digest")
        .description(
            "What the agents did on one day: sessions, commits, files changed, PRs opened and merged, decisions posted and answered"
        )
        .option("--date <day>", "today (default), yesterday or YYYY-MM-DD")
        .option("--markdown", "print the markdown note instead of the summary")
        .option("--export", "write the note to the configured folder (tools hub digest config --folder)")
        .option("--folder <path>", "with --export: write here instead of the configured folder")
        .option("--no-prs", "skip the PR list (the one network call)")
        .option("--json", "machine-readable output (the hub's Today panel reads this)")
        .action(
            async (opts: {
                date?: string;
                markdown?: boolean;
                export?: boolean;
                folder?: string;
                prs?: boolean;
                json?: boolean;
            }) => {
                const window = digestDay(opts.date);

                if (!window) {
                    out.log.error(`--date takes today, yesterday or YYYY-MM-DD, got "${opts.date}"`);
                    process.exitCode = 1;
                    return;
                }

                const folder = opts.folder ?? (await readDigestConfig()).folder;

                if (opts.export && !folder) {
                    out.log.error(
                        "No export folder yet. Set one: tools hub digest config --folder <vault folder>, or pass --folder <path>"
                    );
                    process.exitCode = 1;
                    return;
                }

                const result = await buildDigest({ window, prs: opts.prs !== false });
                const exported = opts.export && folder ? exportDigest(result, folder) : null;

                if (opts.json) {
                    out.result(exported ? { ...result, exported } : result);
                    return;
                }

                if (opts.markdown) {
                    out.print(digestMarkdown(result));
                } else {
                    out.println(pc.bold(`Agents digest ${result.date}`));
                    out.println(
                        [
                            `${result.sessions.length} sessions`,
                            `${result.commits.length} commits`,
                            `${result.files.total} files (+${result.files.added} −${result.files.removed})`,
                            `${result.prs.opened.length} PRs opened, ${result.prs.merged.length} merged`,
                            `${result.decisions.posted.length} decisions posted, ${result.decisions.answered.length} answered`,
                        ].join(" · ")
                    );

                    for (const session of result.sessions.slice(0, 15)) {
                        out.println(
                            `  ${session.lastAt.slice(11, 16)}  ${(session.provider ?? "").padEnd(6)} ${(session.project ?? "").padEnd(18)} ${session.title.slice(0, 70)}`
                        );
                    }

                    for (const warning of result.warnings) {
                        out.println(pc.yellow(`  ! ${warning}`));
                    }
                }

                if (exported) {
                    out.log.success(`Exported ${exported}`);
                }
            }
        );

    digest
        .command("config")
        .description("Show or set where --export (and the hub's Export to vault) writes the note")
        .option("--folder <path>", "the folder, for example a daily folder of your notes vault")
        .option("--clear", "forget the folder")
        .option("--json", "machine-readable output")
        .action(async (opts: { folder?: string; clear?: boolean; json?: boolean }) => {
            const config =
                opts.folder !== undefined || opts.clear
                    ? await writeDigestConfig({ folder: opts.clear ? null : (opts.folder ?? null) })
                    : await readDigestConfig();

            if (opts.json) {
                out.result({ ...config, configPath: digestConfigPath() });
                return;
            }

            out.println(`Export folder: ${config.folder ?? "not set"} (${digestConfigPath()})`);
        });
}
