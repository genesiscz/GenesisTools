import { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { discoverTools } from "../tools/lib/discovery";

const program = new Command()
	.name("update")
	.description("Update GenesisTools to the latest version")
	.action(async () => {
		const genesisPath = process.env.GENESIS_TOOLS_PATH || resolve(__dirname, "..");
		const srcDir = join(genesisPath, "src");

		console.log(chalk.cyan("\n  Updating GenesisTools...\n"));

		// 1. Git pull
		console.log(chalk.dim("  Pulling latest changes..."));
		const pull = spawnSync("git", ["pull"], {
			cwd: genesisPath,
			stdio: "inherit",
		});
		if (pull.status !== 0) {
			console.error(chalk.red("  Failed to git pull"));
			process.exit(1);
		}

		// 2. Bun install
		console.log(chalk.dim("\n  Installing dependencies..."));
		const install = spawnSync("bun", ["install"], {
			cwd: genesisPath,
			stdio: "inherit",
		});
		if (install.status !== 0) {
			console.error(chalk.red("  Failed to bun install"));
			process.exit(1);
		}

		// 3. Claude Code plugin management (if running in Claude Code)
		if (process.env.CLAUDE_CODE_SESSION_ID) {
			console.log(chalk.dim("\n  Updating Claude Code plugin..."));

			// marketplace add (may fail — that's OK)
			spawnSync(
				"claude",
				["plugin", "marketplace", "add", "https://github.com/genesiscz/GenesisTools"],
				{ stdio: "inherit", timeout: 30_000 },
			);

			// plugin install
			const pluginInstall = spawnSync(
				"claude",
				["plugin", "install", "genesis-tools@genesis-tools"],
				{ stdio: "inherit", timeout: 30_000 },
			);
			if (pluginInstall.status !== 0) {
				console.log(chalk.yellow("  Plugin install had issues (may already be installed)"));
			}

			// plugin update
			const pluginUpdate = spawnSync(
				"claude",
				["plugin", "update", "genesis-tools@genesis-tools"],
				{ stdio: "inherit", timeout: 30_000 },
			);
			if (pluginUpdate.status !== 0) {
				console.log(chalk.yellow("  Plugin update had issues"));
			}
		}

		// 4. Show latest changelog entry
		const changelogPath = join(genesisPath, "CHANGELOG.md");
		if (existsSync(changelogPath)) {
			const changelog = readFileSync(changelogPath, "utf-8");
			const latestEntry = extractLatestEntry(changelog);
			if (latestEntry) {
				console.log(chalk.cyan("\n  Latest changes:"));
				console.log(
					chalk.dim("  " + latestEntry.split("\n").join("\n  ")),
				);
			}
		}

		// 5. "Did you know" message
		const tools = discoverTools(srcDir);
		const skills = discoverSkills(
			join(genesisPath, "plugins/genesis-tools/skills"),
		);

		console.log(chalk.green("\n  GenesisTools updated successfully!\n"));
		console.log(
			chalk.cyan(
				"  Did you know we have a lot of Claude tools available? Install with:\n",
			),
		);
		console.log(
			"    claude plugin marketplace add https://github.com/genesiscz/GenesisTools",
		);
		console.log(
			"    claude plugin install genesis-tools@genesis-tools\n",
		);

		console.log(chalk.cyan("  Available commands:"));
		for (const tool of tools.slice(0, 20)) {
			console.log(
				`    ${chalk.bold(tool.name)} - ${chalk.dim(tool.description)}`,
			);
		}
		if (tools.length > 20) {
			console.log(
				chalk.dim(
					`    ... and ${tools.length - 20} more. Run 'tools' to see all.`,
				),
			);
		}

		console.log(chalk.cyan("\n  Available skills:"));
		for (const skill of skills) {
			console.log(
				`    ${chalk.bold(`genesis-tools:${skill.name}`)} - ${chalk.dim(skill.description)}`,
			);
		}

		console.log("");
	});

function extractLatestEntry(changelog: string): string | null {
	const lines = changelog.split("\n");
	let start = -1;
	let end = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## ") && start === -1) {
			start = i;
		} else if (lines[i].startsWith("## ") && start !== -1) {
			end = i;
			break;
		}
	}
	if (start === -1) return null;
	return lines.slice(start, end).join("\n").trim();
}

function discoverSkills(
	skillsDir: string,
): Array<{ name: string; description: string }> {
	if (!existsSync(skillsDir)) return [];
	const skills: Array<{ name: string; description: string }> = [];
	for (const entry of readdirSync(skillsDir)) {
		const skillFile = join(skillsDir, entry, "SKILL.md");
		if (existsSync(skillFile)) {
			const content = readFileSync(skillFile, "utf-8");
			const descMatch = content.match(/^description:\s*(.+)$/m);
			skills.push({
				name: entry,
				description: descMatch?.[1]?.trim() ?? entry,
			});
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

program.parse();
