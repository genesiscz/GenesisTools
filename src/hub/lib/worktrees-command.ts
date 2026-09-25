import * as p from "@clack/prompts";
import { isInteractive, parseNonNegativeInt, suggestCommand } from "@genesiscz/utils/cli";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import {
    DEFAULT_LIVE_MINUTES,
    removeWorktrees,
    scanWorktrees,
    unresolvedBase,
    type WorktreeCleanupRow,
    worktreeSizes,
} from "./worktrees";

interface ScanFlags {
    liveMinutes: number;
    base?: string;
    json?: boolean;
}

/** `--live-minutes abc` is a usage error with commander's message and exit code, not a stack trace. */
function liveMinutesArg(value: string): number {
    try {
        return parseNonNegativeInt(value, "--live-minutes");
    } catch (err) {
        throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
    }
}

function ago(epochMs: number | null): string {
    if (epochMs === null) {
        return "—";
    }

    const days = Math.floor((Date.now() - epochMs) / 86_400_000);

    if (days > 0) {
        return `${days}d ago`;
    }

    const hours = Math.floor((Date.now() - epochMs) / 3_600_000);
    return hours > 0 ? `${hours}h ago` : "just now";
}

function renderRows(rows: WorktreeCleanupRow[]): void {
    renderCliHeader("Worktree cleanup", "linked worktrees and whether removing them loses anything");
    const table = createBoxTable(["REPO", "BRANCH", "VERDICT", "ACTIVITY", "STATE"]);

    for (const row of rows) {
        table.push([
            row.repo,
            truncateDisplay(row.branch ?? `(detached ${row.head.slice(0, 9)})`, 44),
            row.verdict ? `${row.verdict} ${pc.dim(row.how ?? "")}` : pc.dim("—"),
            ago(row.lastActivityAt),
            row.removable
                ? formatDotStatus("ok", "removable")
                : formatDotStatus("warn", truncateDisplay(row.blockers[0]?.text ?? "blocked", 60)),
        ]);
    }

    out.println(table.toString());
    const removable = rows.filter((r) => r.removable).length;
    out.println(`${rows.length} linked worktrees, ${removable} removable`);

    if (removable > 0) {
        out.println(pc.dim(suggestCommand("tools hub", { replaceCommand: ["worktrees", "remove", "<path...>"] })));
    }
}

/** `tools hub worktrees …`: the cleanup panel's data doors (list, size) and its one writer (remove). */
export function registerWorktreesCommand(program: Command): void {
    const worktrees = program
        .command("worktrees")
        .description("Linked worktrees that are safe to remove: merged, clean, no stash, nothing running in them");

    worktrees
        .command("list")
        .description("Every linked worktree of the repositories with the removal rules' answer; read-only")
        .argument("[repos...]", "folders inside git repositories (default: the current one)")
        .option(
            "--live-minutes <n>",
            "an agent session written this recently still uses its folder",
            liveMinutesArg,
            DEFAULT_LIVE_MINUTES
        )
        .option("--base <ref>", "judge every branch against this ref instead of the detected base")
        .option("--json", "machine-readable output")
        .action(async (repos: string[], opts: ScanFlags) => {
            const report = await scanWorktrees({
                repos: repos.length > 0 ? repos : [process.cwd()],
                liveMinutes: opts.liveMinutes,
                base: opts.base,
            });
            const baseProblem = unresolvedBase(report, opts.base);

            if (baseProblem) {
                out.log.error(baseProblem);
                process.exitCode = 1;
            }

            if (opts.json) {
                out.result(report);
                return;
            }

            renderRows(report.rows);

            for (const warning of report.warnings) {
                out.log.warn(warning);
            }
        });

    worktrees
        .command("size")
        .description(
            "Clone-aware disk size of each worktree (the tools du core) and the floor of what removing it frees"
        )
        .argument("<paths...>", "worktree folders")
        .option("--json", "machine-readable output")
        .action(async (paths: string[], opts: { json?: boolean }) => {
            const sizes = await worktreeSizes(paths);

            if (opts.json) {
                out.result(sizes);
                return;
            }

            for (const size of sizes) {
                const freeable =
                    size.freeableBytes === null ? "" : `, frees at least ${formatBytes(size.freeableBytes)}`;
                out.println(
                    size.error ? `${size.path}: ${size.error}` : `${formatBytes(size.bytes)}${freeable}  ${size.path}`
                );
            }
        });

    worktrees
        .command("remove")
        .description(
            "Re-check each worktree and run `git worktree remove` (never --force) on the ones still removable; branches stay"
        )
        .argument("<paths...>", "worktree folders")
        .option("--yes", "skip the confirmation (the hub asks its own first)")
        .option(
            "--live-minutes <n>",
            "an agent session written this recently still uses its folder",
            liveMinutesArg,
            DEFAULT_LIVE_MINUTES
        )
        .option("--base <ref>", "judge every branch against this ref instead of the detected base")
        .option("--json", "machine-readable output")
        .action(async (paths: string[], opts: ScanFlags & { yes?: boolean }) => {
            if (!opts.yes) {
                if (!isInteractive()) {
                    out.log.error("Non-interactive: pass --yes once you have read `tools hub worktrees list`.");
                    out.log.info(
                        suggestCommand("tools hub", {
                            replaceCommand: ["worktrees", "remove", ...paths],
                            add: ["--yes"],
                        })
                    );
                    process.exitCode = 2;
                    return;
                }

                const ok = await p.confirm({
                    message: `Remove ${paths.length} worktree folder(s)? Ignored files in them (node_modules, .env) go too.`,
                    initialValue: false,
                });

                if (p.isCancel(ok) || !ok) {
                    out.log.info("Cancelled. Nothing removed.");
                    process.exitCode = 1;
                    return;
                }
            }

            const outcomes = await removeWorktrees({
                paths,
                liveMinutes: opts.liveMinutes,
                base: opts.base,
            });

            if (outcomes.some((o) => !o.removed)) {
                process.exitCode = 1;
            }

            if (opts.json) {
                out.result(outcomes);
                return;
            }

            for (const outcome of outcomes) {
                if (outcome.removed) {
                    out.log.success(
                        `removed ${outcome.path}${outcome.branch ? pc.dim(` (branch ${outcome.branch} kept)`) : ""}`
                    );
                } else {
                    out.log.error(`kept ${outcome.path}: ${outcome.reasons.join("; ")}`);
                }
            }
        });
}
