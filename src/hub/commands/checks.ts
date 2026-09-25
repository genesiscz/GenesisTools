import { resolve } from "node:path";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { checkLog, DEFAULT_LOG_LINES } from "../lib/checks";
import { fixCheck } from "../lib/checks-fix";
import { HubPrError } from "../lib/pr";

/** `tools hub pr check-log <url>`: the failing part of one CI check's log, for the PR detail's Checks section. */
export function registerCheckLogCommand(pr: Command): void {
    pr.command("check-log")
        .description(
            "The failing part of a CI check's log (GitHub Actions job or run, GitLab job or pipeline); read-only, finished logs cached 7 days"
        )
        .argument("<url>", "the check's URL from `pr show` (checks[].url)")
        .option("--lines <n>", "lines per failed section", String(DEFAULT_LOG_LINES))
        .option("--no-cache", "fetch again even when a cached log exists")
        .option("--json", "machine-readable output")
        .action(async (url: string, opts: { lines: string; cache: boolean; json?: boolean }) => {
            const maxLines = Number(opts.lines);

            if (!Number.isInteger(maxLines) || maxLines < 1) {
                out.log.error(`--lines takes a positive whole number, got ${opts.lines}`);
                process.exitCode = 1;
                return;
            }

            const result = await checkLog({ url, maxLines, fresh: !opts.cache });

            if (opts.json) {
                out.result(result);
                return;
            }

            if (result.error) {
                out.log.error(result.error);
                process.exitCode = 1;
            }

            for (const line of result.errors) {
                out.println(`error: ${line}`);
            }

            for (const section of result.sections) {
                out.println(`\n── ${section.name} (${section.lines.length} of ${section.totalLines} lines) ──`);
                out.println(section.lines.join("\n"));
            }

            out.println(
                `\n${result.cached ? "cached" : `${result.elapsedMs} ms`}${result.final ? "" : ", still running"}`
            );
        });

    pr.command("fix-check")
        .description(
            "Send a failed check's log to the session that owns the branch as a task file (the fix-threads path); nothing is posted"
        )
        .requiredOption("--check <url>", "the failed check's URL (checks[].url from `pr show`)")
        .requiredOption("--name <name>", "the check's name, for the task")
        .option("--session <id>", "send to this session instead of the best live one that worked on the branch")
        .option("--no-send", "only write the task file and print the prompt (to start a new agent with it)")
        .option("--no-focus", "do not focus the session's cmux pane after the send")
        .option("--no-activate", "focus the pane without raising the cmux app")
        .option(
            "--dry-run",
            "print the plan (task file, prompt, owner, candidates); fetch the log but write and send nothing"
        )
        .option("--repo <path>", "the checkout whose branch names the PR/MR (default: the current directory)", ".")
        .option("--pr <ref>", "this PR/MR instead of the branch's: its URL, or <repoPath>#<number>")
        .option("--json", "machine-readable output")
        .action(
            async (opts: {
                check: string;
                name: string;
                session?: string;
                send: boolean;
                focus: boolean;
                activate: boolean;
                dryRun?: boolean;
                repo: string;
                pr?: string;
                json?: boolean;
            }) => {
                try {
                    const result = await fixCheck({
                        repo: resolve(opts.repo),
                        pr: opts.pr,
                        checkUrl: opts.check,
                        checkName: opts.name,
                        session: opts.session,
                        dryRun: opts.dryRun,
                        send: opts.send,
                        focus: opts.focus,
                        activate: opts.activate,
                    });

                    if (result.error && !result.sent && opts.send) {
                        process.exitCode = 1;
                    }

                    if (opts.json) {
                        out.result(result);
                        return;
                    }

                    out.println(
                        [
                            `${result.pr.label}: task in ${result.file}${result.written ? "" : " (not written)"}`,
                            result.owner
                                ? `Owner: ${result.owner.provider} ${result.owner.sessionId.slice(0, 8)} ${result.owner.live ? "(open in cmux)" : "(not open in cmux)"}`
                                : "Owner: none",
                            result.sent ? `Sent${result.focused ? " and focused" : ""}.` : `Prompt: ${result.prompt}`,
                            result.error ? `Error: ${result.error}` : null,
                        ]
                            .filter(Boolean)
                            .join("\n")
                    );
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    out.log.error(message);

                    if (opts.json) {
                        out.result({ error: message, code: error instanceof HubPrError ? error.code : "provider" });
                    }

                    process.exitCode = 1;
                }
            }
        );
}
