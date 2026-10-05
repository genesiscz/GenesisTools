/**
 * `tools git changes` — what did I touch, and when?
 *
 * Lists the uncommitted files (or the files of the last N commits) newest first, grouped by how
 * long ago each was modified. Reads only: nothing is staged, written or rewritten.
 */

import {
    describeCommitted,
    describeUncommitted,
    type FileChange,
    groupChangesByTime,
    statusLetter,
    type TimeGroup,
} from "@app/git/lib/changes";
import { readCommittedChanges, readUncommittedChanges } from "@app/git/lib/changes-read";
import { formatDateTime } from "@genesiscz/utils/date";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import type { Command } from "commander";
import pc from "picocolors";

const log = logger.scoped("git-changes").log;

interface Options {
    commits?: string;
    cwd?: string;
}

function countOf(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function statusColor(status: string): (text: string) => string {
    const letter = statusLetter(status);

    if (letter === "M" || letter === " ") {
        return pc.yellow;
    }

    if (letter === "A") {
        return pc.green;
    }

    if (letter === "D") {
        return pc.red;
    }

    if (letter === "R") {
        return pc.blue;
    }

    if (letter === "C") {
        return pc.cyan;
    }

    return pc.gray;
}

function printGroups(groups: TimeGroup[], describe: (status: string) => string): void {
    for (const group of groups) {
        out.println(pc.bold(pc.cyan(`\n${group.label} (${countOf(group.files.length, "file")}):`)));

        for (const { file, status, mtime } of group.files) {
            const relative = formatRelativeTime(mtime, {
                maxDays: 7,
                fallbackFormat: (d) => formatDateTime(d, { absolute: "datetime" }),
            });
            const absolute = formatDateTime(mtime, { absolute: "datetime" });

            out.println(`  ${statusColor(status)(status)}  ${pc.white(file)} ${pc.gray(`(${describe(status)})`)}`);
            out.println(`      ${pc.gray(relative)} ${pc.dim(`(${absolute})`)}`);
        }
    }
}

async function runChanges(opts: Options): Promise<number> {
    const now = new Date();
    let files: FileChange[];
    let title: string;
    let emptyMessage: string;
    let describe: (status: string) => string;

    if (opts.commits === undefined) {
        files = await readUncommittedChanges({ cwd: opts.cwd, now });
        title = "Uncommitted Changes";
        emptyMessage = "No uncommitted changes found.";
        describe = describeUncommitted;
    } else {
        const commits = /^\d+$/.test(opts.commits) ? Number(opts.commits) : 0;

        if (!Number.isSafeInteger(commits) || commits < 1) {
            out.log.error("--commits must be a positive integer.");
            return 1;
        }

        files = await readCommittedChanges({ cwd: opts.cwd, commits });
        title = `Last ${countOf(commits, "Commit")}`;
        emptyMessage = `No changes found in the last ${countOf(commits, "commit")}.`;
        describe = describeCommitted;
    }

    if (files.length === 0) {
        out.println(`${pc.green("✔")} ${emptyMessage}`);
        return 0;
    }

    log.debug({ files: files.length, title }, "grouping changes by time");
    out.println(pc.bold(`\n📋 ${title} (${countOf(files.length, "file")}):`));
    printGroups(groupChangesByTime(files, now), describe);
    out.println("");

    return 0;
}

export function registerChangesCommand(parent: Command, _storage: Storage): void {
    parent
        .command("changes")
        .description("Show uncommitted changes (or the last N commits) grouped by file modification time")
        .option("-c, --commits <n>", "Show the files of the last N commits instead of uncommitted changes")
        .option("-C, --cwd <path>", "Repository path")
        .action(async (options: Options) => {
            try {
                process.exitCode = await runChanges(options);
            } catch (err) {
                log.error({ error: err }, "git changes failed");
                out.log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}
