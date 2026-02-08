/**
 * Git Configure Authors Command
 *
 * Manage author identities for commit filtering.
 * Supports add/remove/list flags and interactive multiselect from git log authors.
 *
 * Usage:
 *   tools git configure-authors --add "Your Name" --add "username"
 *   tools git configure-authors --remove "username"
 *   tools git configure-authors --list
 *   tools git configure-authors    # interactive (default)
 */

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Storage } from "@app/utils/storage";
import { Executor } from "@app/utils/cli";

interface ConfigureAuthorsOptions {
	add?: string[];
	remove?: string;
	list?: boolean;
}

async function getRepoAuthors(limit: number = 500): Promise<string[]> {
	const executor = new Executor({ prefix: "git", verbose: false });
	const result = await executor.exec([
		"log",
		"--all",
		`-${limit}`,
		"--format=%an",
	]);

	if (!result.success || !result.stdout.trim()) {
		return [];
	}

	const authors = new Set<string>();
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();

		if (trimmed) {
			authors.add(trimmed);
		}
	}

	return [...authors].sort();
}

async function handleConfigureAuthors(
	storage: Storage,
	options: ConfigureAuthorsOptions,
): Promise<void> {
	const currentAuthors = (await storage.getConfigValue<string[]>("authors")) ?? [];

	// --list flag
	if (options.list) {
		if (currentAuthors.length === 0) {
			console.log(chalk.dim("No authors configured."));
		} else {
			console.log(chalk.bold("Configured authors:"));
			for (const author of currentAuthors) {
				console.log(`  ${chalk.green("*")} ${author}`);
			}
		}
		return;
	}

	// --add flag
	if (options.add && options.add.length > 0) {
		const newAuthors = [...new Set([...currentAuthors, ...options.add])];
		await storage.setConfigValue("authors", newAuthors);
		const added = options.add.filter((a) => !currentAuthors.includes(a));

		if (added.length > 0) {
			console.log(chalk.green(`Added: ${added.join(", ")}`));
		} else {
			console.log(chalk.dim("All specified authors were already configured."));
		}

		console.log(chalk.dim(`Total authors: ${newAuthors.length}`));
		return;
	}

	// --remove flag
	if (options.remove) {
		const filtered = currentAuthors.filter((a) => a !== options.remove);

		if (filtered.length === currentAuthors.length) {
			console.log(chalk.yellow(`Author "${options.remove}" not found in config.`));
			return;
		}

		await storage.setConfigValue("authors", filtered);
		console.log(chalk.green(`Removed: ${options.remove}`));
		console.log(chalk.dim(`Remaining authors: ${filtered.length}`));
		return;
	}

	// Interactive mode (default)
	p.intro(chalk.bold("Configure Git Authors"));

	const spinner = p.spinner();
	spinner.start("Fetching authors from git history...");
	const repoAuthors = await getRepoAuthors();
	spinner.stop(`Found ${repoAuthors.length} unique authors`);

	if (repoAuthors.length === 0) {
		p.log.warn("No authors found in git history. Make sure you are in a git repository.");
		p.outro("Done");
		return;
	}

	const selected = await p.multiselect({
		message: "Select authors to track (space to toggle, enter to confirm):",
		options: repoAuthors.map((author) => ({
			value: author,
			label: author,
		})),
		initialValues: currentAuthors.filter((a) => repoAuthors.includes(a)),
	});

	if (p.isCancel(selected)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	await storage.setConfigValue("authors", selected as string[]);
	p.log.success(`Saved ${(selected as string[]).length} author(s) to config.`);
	p.outro("Done");
}

export function registerConfigureAuthorsCommand(parent: Command, storage: Storage): void {
	parent
		.command("configure-authors")
		.alias("authors")
		.description("Manage author identities for commit filtering")
		.option("--add <name...>", "Add author(s) to config (repeatable)")
		.option("--remove <name>", "Remove an author from config")
		.option("--list", "List currently configured authors")
		.action(async (options: ConfigureAuthorsOptions) => {
			await handleConfigureAuthors(storage, options);
		});
}
