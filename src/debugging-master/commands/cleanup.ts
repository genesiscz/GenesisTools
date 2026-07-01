import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import { out } from "@app/logger";
import { suggestCommand } from "@app/utils/cli/executor";
import type { Command } from "commander";
import { glob } from "glob";
import pc from "picocolors";

const TOOL = "tools debugging-master";
const REGION_START = /\/\/\s*#region\s+@dbg/;
const REGION_END = /\/\/\s*#endregion\s+@dbg/;

interface BlockRange {
    start: number;
    end: number;
}

function findBlocks(content: string): { blocks: BlockRange[]; warnings: string[] } {
    const lines = content.split("\n");
    const blocks: BlockRange[] = [];
    const warnings: string[] = [];
    const startStack: number[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (REGION_START.test(lines[i])) {
            startStack.push(i);
        } else if (REGION_END.test(lines[i])) {
            const blockStart = startStack.pop();
            if (blockStart !== undefined) {
                blocks.push({ start: blockStart, end: i });
            } else {
                warnings.push(`'#endregion @dbg' at line ${i + 1} without a matching '#region @dbg'`);
            }
        }
    }

    for (const unmatchedStart of startStack) {
        warnings.push(`'#region @dbg' at line ${unmatchedStart + 1} without a matching '#endregion @dbg'`);
    }

    return { blocks, warnings };
}

function removeBlocks(content: string, blocks: BlockRange[]): string {
    const lines = content.split("\n");
    const linesToRemove = new Set<number>();

    for (const block of blocks) {
        for (let i = block.start; i <= block.end; i++) {
            linesToRemove.add(i);
        }
    }

    return lines.filter((_, i) => !linesToRemove.has(i)).join("\n");
}

async function checkGitDiff(filePath: string): Promise<{ hasOnlyWhitespace: boolean; diff: string }> {
    const proc = Bun.spawn(["git", "diff", "--no-color", filePath], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const diff = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    if (!diff.trim()) {
        return { hasOnlyWhitespace: true, diff: "" };
    }

    const changedLines = diff
        .split("\n")
        .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
    const hasOnlyWhitespace = changedLines.every((l) => l.slice(1).trim() === "");

    return { hasOnlyWhitespace, diff };
}

async function stashInstrumentation(files: string[], message: string, projectPath: string): Promise<boolean> {
    // `-u` includes untracked files (e.g. freshly-copied llm-log.ts).
    // Don't combine with `git add -N` — intent-to-add entries make `stash -u` fail with
    // "Entry 'X' not uptodate. Cannot merge."
    const stashProc = Bun.spawn(["git", "stash", "push", "-u", "-m", message, "--", ...files], {
        cwd: projectPath,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderr = await new Response(stashProc.stderr).text();
    const exitCode = await stashProc.exited;
    if (exitCode !== 0) {
        throw new Error(`git stash failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const stdout = await new Response(stashProc.stdout).text();
    return /Saved working directory|Created stash/i.test(stdout);
}

async function repairFile(filePath: string): Promise<void> {
    const proc = Bun.spawn(["git", "checkout", filePath], {
        stdout: "ignore",
        stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`git checkout failed (exit ${exitCode}): ${stderr.trim()}`);
    }
}

export function registerCleanupCommand(program: Command): void {
    program
        .command("cleanup")
        .description(
            "Remove debug instrumentation and/or archive session logs (opt-in: pick --blocks, --clean-logs, or both)"
        )
        .option("--blocks", "Remove @dbg instrumentation blocks from source files")
        .option(
            "--clean-logs [path]",
            "Archive the active session jsonl + meta out of the sessions dir (default destination: /tmp; pass a path to keep them permanently)"
        )
        .option("--repair-formatting", "Auto-fix formatting-only diffs after block removal (implies --blocks)")
        .option(
            "--no-stash",
            "Skip stashing @dbg blocks into git before removing them (stash is on by default with --blocks)"
        )
        .option(
            "--stash-message <msg>",
            "Custom message to attach to the git stash (default: auto-generated timestamp)"
        )
        .action(
            async (
                opts: {
                    blocks?: boolean;
                    cleanLogs?: string | boolean;
                    repairFormatting?: boolean;
                    stash?: boolean;
                    stashMessage?: string;
                },
                cmd: Command
            ) => {
                // Modifier flags imply their owning action so old muscle-memory keeps working.
                const removeBlocksRequested = opts.blocks === true || opts.repairFormatting === true;
                const cleanLogsRequested = opts.cleanLogs !== undefined && opts.cleanLogs !== false;
                const cleanLogsPath = typeof opts.cleanLogs === "string" ? opts.cleanLogs : undefined;

                if (!removeBlocksRequested && !cleanLogsRequested) {
                    cmd.help();
                    return;
                }

                const globalOpts = program.opts<{ session?: string }>();
                const sm = new SessionManager();
                const projectPath = process.cwd();
                const ignore = ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**", "**/build/**"];

                // ─── BLOCK REMOVAL (gated on --blocks / --repair-formatting) ───────────────
                if (removeBlocksRequested) {
                    await runBlockRemoval({ projectPath, ignore, opts });
                }

                // ─── LOG ARCHIVE (gated on --clean-logs) ───────────────────────────────────
                if (cleanLogsRequested) {
                    await runLogArchive({ sm, sessionOverride: globalOpts.session, keepPath: cleanLogsPath });
                }
            }
        );
}

interface BlockRemovalArgs {
    projectPath: string;
    ignore: string[];
    opts: { repairFormatting?: boolean; stash?: boolean; stashMessage?: string };
}

async function runBlockRemoval({ projectPath, ignore, opts }: BlockRemovalArgs): Promise<void> {
    // --- A. Scan for @dbg blocks ---
    const patterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.php"];
    const files = await glob(patterns, { cwd: projectPath, ignore, absolute: true });

    const fileBlockMap = new Map<string, BlockRange[]>();
    let totalBlocks = 0;
    const allWarnings: { file: string; warning: string }[] = [];

    for (const file of files) {
        const content = readFileSync(file, "utf-8");
        const { blocks, warnings } = findBlocks(content);

        for (const w of warnings) {
            allWarnings.push({ file, warning: w });
        }

        if (blocks.length === 0) {
            continue;
        }

        fileBlockMap.set(file, blocks);
        totalBlocks += blocks.length;
    }

    if (allWarnings.length > 0) {
        out.println(pc.yellow(`\n${allWarnings.length} unclosed/orphan @dbg region(s) found:`));
        for (const { file, warning } of allWarnings) {
            out.println(`  ${pc.dim(relative(projectPath, file))}: ${warning}`);
        }
        out.println(pc.dim("\nThese regions were skipped. Fix the markers manually, then re-run cleanup."));
    }

    // --- B.0 Stash (default-on; runs BEFORE block removal so the stash captures @dbg blocks) ---
    if (opts.stash !== false) {
        const snippetFiles = await glob(["**/llm-log.ts", "**/llm-log.php"], {
            cwd: projectPath,
            ignore,
            absolute: true,
        });
        const stashTargets = Array.from(new Set([...fileBlockMap.keys(), ...snippetFiles]));

        if (stashTargets.length === 0) {
            out.println(pc.dim("\nNothing to stash (no @dbg blocks and no llm-log snippet found)."));
        } else {
            const note = opts.stashMessage ?? "";
            const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
            const message = note ? `@dbg instrumentation: ${note} (${ts})` : `@dbg instrumentation (${ts})`;

            try {
                const stashed = await stashInstrumentation(stashTargets, message, projectPath);
                if (stashed) {
                    out.println(pc.green(`\nStashed @dbg instrumentation across ${stashTargets.length} file(s):`));
                    out.println(`  ${pc.dim("message:")} ${message}`);
                    out.println("");
                    out.println(pc.bold("To re-apply later (recommend apply, NOT pop — keeps the stash):"));
                    out.println(
                        `  ${pc.cyan("git stash list")}                    ${pc.dim("# find the stash index")}`
                    );
                    out.println(
                        `  ${pc.cyan("git stash apply stash@{0}")}         ${pc.dim("# re-insert @dbg blocks + snippet")}`
                    );
                    out.println(`  ${pc.cyan("git stash show -p stash@{0}")}       ${pc.dim("# preview the diff")}`);
                    out.println(`  ${pc.cyan("git stash drop stash@{0}")}          ${pc.dim("# discard when done")}`);
                    out.println("");
                } else {
                    out.println(
                        pc.yellow("\nNo changes to stash — files already match HEAD (nothing to re-apply later).")
                    );
                }
            } catch (err) {
                out.println(pc.red(`\nStash failed: ${(err as Error).message}`));
                out.println(pc.dim("Skipping removal — re-run without --stash if you want to proceed."));
                return;
            }
        }

        // Re-scan after stash: working tree may have reverted to HEAD; any remaining @dbg
        // blocks (e.g. committed instrumentation) still need removal below.
        fileBlockMap.clear();
        totalBlocks = 0;
        for (const file of files) {
            if (!existsSync(file)) {
                continue;
            }
            const { blocks } = findBlocks(readFileSync(file, "utf-8"));
            if (blocks.length > 0) {
                fileBlockMap.set(file, blocks);
                totalBlocks += blocks.length;
            }
        }
    }

    // --- B. Remove blocks ---
    const modifiedFiles: string[] = [];

    for (const [file, blocks] of fileBlockMap) {
        const content = readFileSync(file, "utf-8");
        const cleaned = removeBlocks(content, blocks);
        writeFileSync(file, cleaned);
        modifiedFiles.push(file);
    }

    if (totalBlocks > 0) {
        out.println(pc.green(`Removed ${totalBlocks} @dbg block(s) from ${modifiedFiles.length} file(s):`));
        for (const file of modifiedFiles) {
            const blocks = fileBlockMap.get(file)!;
            out.println(
                `  ${pc.dim(relative(projectPath, file))} (${blocks.length} block${blocks.length > 1 ? "s" : ""})`
            );
        }
    } else {
        out.println(pc.dim("No @dbg blocks found."));
    }

    // --- C. Git diff check ---
    if (modifiedFiles.length > 0) {
        const formatOnlyFiles: string[] = [];
        const realDiffFiles: { file: string; diff: string }[] = [];

        const diffResults = await Promise.all(
            modifiedFiles.map(async (file) => ({
                file,
                ...(await checkGitDiff(file)),
            }))
        );

        for (const { file, hasOnlyWhitespace, diff } of diffResults) {
            if (hasOnlyWhitespace && diff) {
                formatOnlyFiles.push(file);
            } else if (diff) {
                realDiffFiles.push({ file, diff });
            }
        }

        if (realDiffFiles.length > 0) {
            out.println(`\n${pc.yellow(`${realDiffFiles.length} file(s) have real diffs remaining:`)}`);
            for (const { file } of realDiffFiles) {
                out.println(`  ${relative(projectPath, file)}`);
            }
        }

        if (formatOnlyFiles.length > 0) {
            if (opts.repairFormatting) {
                for (const file of formatOnlyFiles) {
                    await repairFile(file);
                }
                out.println(pc.green(`\nRepaired formatting in ${formatOnlyFiles.length} file(s).`));
            } else {
                out.println(`\n${pc.yellow(`${formatOnlyFiles.length} file(s) have formatting-only diffs:`)}`);
                for (const file of formatOnlyFiles) {
                    out.println(`  ${pc.dim(relative(projectPath, file))}`);
                }
                out.println(`\n${pc.dim("Tip:")} ${suggestCommand(TOOL, { add: ["--repair-formatting"] })}`);
            }
        }
    }
}

interface LogArchiveArgs {
    sm: SessionManager;
    sessionOverride: string | undefined;
    /** Destination directory. `undefined` → archive to /tmp (cleared on reboot). */
    keepPath: string | undefined;
}

async function runLogArchive({ sm, sessionOverride, keepPath }: LogArchiveArgs): Promise<void> {
    let sessionName: string | undefined;
    try {
        sessionName = await sm.resolveSession(sessionOverride);
    } catch {
        // No active session to archive
    }

    if (!sessionName) {
        out.println(pc.dim("\nNo active session found — skipping log archival."));
        return;
    }

    const sessionPath = await sm.getSessionPath(sessionName);
    const metaPath = sessionPath.replace(".jsonl", ".meta.json");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    if (!existsSync(sessionPath)) {
        out.println(pc.dim("\nNo session log file to archive."));
        return;
    }

    let archivePath: string;
    if (keepPath) {
        const keepDir = resolve(keepPath);
        if (!existsSync(keepDir)) {
            mkdirSync(keepDir, { recursive: true });
        }
        archivePath = join(keepDir, `${timestamp}-llmlog-${sessionName}.jsonl`);
        const archiveMetaPath = join(keepDir, `${timestamp}-llmlog-${sessionName}.meta.json`);
        copyFileSync(sessionPath, archivePath);
        unlinkSync(sessionPath);

        if (existsSync(metaPath)) {
            copyFileSync(metaPath, archiveMetaPath);
            unlinkSync(metaPath);
        }
    } else {
        archivePath = join(tmpdir(), `${timestamp}-llmlog-${sessionName}.jsonl`);
        const archiveMetaPath = join(tmpdir(), `${timestamp}-llmlog-${sessionName}.meta.json`);
        renameSync(sessionPath, archivePath);

        if (existsSync(metaPath)) {
            renameSync(metaPath, archiveMetaPath);
        }
    }

    out.println(`\n${pc.green("Logs archived to:")} ${archivePath}`);
    if (!keepPath) {
        out.println(
            `${pc.dim("Tip: Keep logs permanently →")} ${suggestCommand(TOOL, { add: ["cleanup", "--clean-logs", "./debug-logs/"] })}`
        );
    }
}
