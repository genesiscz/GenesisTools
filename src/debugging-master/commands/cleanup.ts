import type { Command } from "commander";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	copyFileSync,
	mkdirSync,
	unlinkSync,
	renameSync,
} from "node:fs";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { glob } from "glob";
import pc from "picocolors";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import { suggestCommand } from "@app/utils/cli/executor";

const TOOL = "tools debugging-master";
const REGION_START = /\/\/\s*#region\s+@dbg/;
const REGION_END = /\/\/\s*#endregion\s+@dbg/;

interface BlockRange {
	start: number;
	end: number;
}

function findBlocks(content: string): BlockRange[] {
	const lines = content.split("\n");
	const blocks: BlockRange[] = [];
	let blockStart = -1;

	for (let i = 0; i < lines.length; i++) {
		if (REGION_START.test(lines[i])) {
			blockStart = i;
		} else if (REGION_END.test(lines[i]) && blockStart >= 0) {
			blocks.push({ start: blockStart, end: i });
			blockStart = -1;
		}
	}

	return blocks;
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
	await proc.exited;

	if (!diff.trim()) return { hasOnlyWhitespace: true, diff: "" };

	const changedLines = diff
		.split("\n")
		.filter(
			(l) =>
				(l.startsWith("+") || l.startsWith("-")) &&
				!l.startsWith("+++") &&
				!l.startsWith("---"),
		);
	const hasOnlyWhitespace = changedLines.every((l) => l.slice(1).trim() === "");

	return { hasOnlyWhitespace, diff };
}

async function repairFile(filePath: string): Promise<void> {
	const proc = Bun.spawn(["git", "checkout", filePath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
}

export function registerCleanupCommand(program: Command): void {
	program
		.command("cleanup")
		.description("Remove debug instrumentation and archive logs")
		.option("--repair-formatting", "Auto-fix formatting-only diffs after block removal")
		.option("--keep-logs [path]", "Keep logs at specified path instead of /tmp")
		.action(async (opts: { repairFormatting?: boolean; keepLogs?: string | true }) => {
			const globalOpts = program.opts<{ session?: string }>();
			const sm = new SessionManager();
			const projectPath = process.cwd();

			// --- A. Scan for @dbg blocks ---
			const patterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.php"];
			const ignore = ["**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**", "**/build/**"];

			const files = await glob(patterns, { cwd: projectPath, ignore, absolute: true });

			const fileBlockMap = new Map<string, BlockRange[]>();
			let totalBlocks = 0;

			for (const file of files) {
				const content = readFileSync(file, "utf-8");
				const blocks = findBlocks(content);
				if (blocks.length === 0) continue;

				fileBlockMap.set(file, blocks);
				totalBlocks += blocks.length;
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
				console.log(
					pc.green(`Removed ${totalBlocks} @dbg block(s) from ${modifiedFiles.length} file(s):`),
				);
				for (const file of modifiedFiles) {
					const blocks = fileBlockMap.get(file)!;
					console.log(`  ${pc.dim(relative(projectPath, file))} (${blocks.length} block${blocks.length > 1 ? "s" : ""})`);
				}
			} else {
				console.log(pc.dim("No @dbg blocks found."));
			}

			// --- C. Git diff check ---
			if (modifiedFiles.length > 0) {
				const formatOnlyFiles: string[] = [];
				const realDiffFiles: { file: string; diff: string }[] = [];

				for (const file of modifiedFiles) {
					const { hasOnlyWhitespace, diff } = await checkGitDiff(file);
					if (hasOnlyWhitespace && diff) {
						formatOnlyFiles.push(file);
					} else if (diff) {
						realDiffFiles.push({ file, diff });
					}
				}

				if (realDiffFiles.length > 0) {
					console.log(`\n${pc.yellow(`${realDiffFiles.length} file(s) have real diffs remaining:`)}`);
					for (const { file } of realDiffFiles) {
						console.log(`  ${relative(projectPath, file)}`);
					}
				}

				if (formatOnlyFiles.length > 0) {
					if (opts.repairFormatting) {
						for (const file of formatOnlyFiles) {
							await repairFile(file);
						}
						console.log(
							pc.green(`\nRepaired formatting in ${formatOnlyFiles.length} file(s).`),
						);
					} else {
						console.log(
							`\n${pc.yellow(`${formatOnlyFiles.length} file(s) have formatting-only diffs:`)}`,
						);
						for (const file of formatOnlyFiles) {
							console.log(`  ${pc.dim(relative(projectPath, file))}`);
						}
						console.log(
							`\n${pc.dim("Tip:")} ${suggestCommand(TOOL, { add: ["cleanup", "--repair-formatting"] })}`,
						);
					}
				}
			}

			// --- D. Archive logs ---
			let sessionName: string | undefined;
			try {
				sessionName = await sm.resolveSession(globalOpts.session);
			} catch {
				// No active session to archive
			}

			if (sessionName) {
				const sessionPath = await sm.getSessionPath(sessionName);
				const metaPath = sessionPath.replace(".jsonl", ".meta.json");
				const timestamp = new Date()
					.toISOString()
					.replace(/[:.]/g, "-")
					.slice(0, 19);

				if (existsSync(sessionPath)) {
					let archivePath: string;

					if (opts.keepLogs) {
						const keepDir =
							typeof opts.keepLogs === "string"
								? resolve(opts.keepLogs)
								: resolve("debug-logs");
						if (!existsSync(keepDir)) {
							mkdirSync(keepDir, { recursive: true });
						}
						archivePath = join(keepDir, `${timestamp}-llmlog-${sessionName}.jsonl`);
						copyFileSync(sessionPath, archivePath);
					} else {
						archivePath = join(
							tmpdir(),
							`${timestamp}-llmlog-${sessionName}.jsonl`,
						);
						renameSync(sessionPath, archivePath);
					}

					if (existsSync(metaPath)) unlinkSync(metaPath);

					console.log(`\n${pc.green("Logs archived to:")} ${archivePath}`);
					if (!opts.keepLogs) {
						console.log(
							`${pc.dim("Tip: Keep logs permanently →")} ${suggestCommand(TOOL, { add: ["cleanup", "--keep-logs", "./debug-logs/"] })}`,
						);
					}
				} else {
					console.log(pc.dim("\nNo session log file to archive."));
				}
			} else {
				console.log(pc.dim("\nNo active session found — skipping log archival."));
			}
		});
}
