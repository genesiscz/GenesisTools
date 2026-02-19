import type { Command } from "commander";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
	CLAUDE_CODE_SKILLS,
	discoverLocalSkills,
	findManifestPath,
	installSkill,
	readManifest,
	writeManifest,
} from "../lib/desktop";

export function registerDesktopCommand(program: Command): void {
	program
		.command("desktop")
		.description("Sync skills from ~/.claude/skills/ to Claude Desktop")
		.option("--all", "Install all skills without interactive selection")
		.option("--list", "List available skills and their install status, then exit")
		.action(async (opts) => {
			p.intro(pc.bgCyan(pc.black(" claude desktop ")));

			const manifestPath = findManifestPath();
			if (!manifestPath) {
				p.cancel("Claude Desktop not found. Is it installed?");
				process.exit(1);
			}

			const manifest = readManifest(manifestPath);
			const allSkills = discoverLocalSkills(manifest);

			const builtInConflicts = allSkills.filter(
				(s) => s.installedEntry?.creatorType === "anthropic",
			);
			if (builtInConflicts.length > 0) {
				p.log.warn(
					`Ignoring local skills that would overwrite built-in skills: ${builtInConflicts.map((s) => s.name).join(", ")}`,
				);
			}
			const skills = allSkills.filter((s) => s.installedEntry?.creatorType !== "anthropic");

			if (skills.length === 0) {
				p.cancel(`No skills found in ${CLAUDE_CODE_SKILLS}`);
				process.exit(0);
			}

			if (opts.list) {
				const lines = skills.map((s) => {
					const status = s.installedEntry
						? pc.green("installed")
						: pc.dim("  not installed");
					return `${status}  ${pc.bold(s.name)}  ${pc.dim(s.description.slice(0, 60))}`;
				});
				p.note(
					lines.join("\n"),
					`Skills in ~/.claude/skills/ (${skills.length} total)`,
				);
				p.outro("Run without --list to install.");
				return;
			}

			let toInstall: typeof skills;

			if (opts.all) {
				toInstall = skills;
				p.log.info(`Installing all ${skills.length} skill(s)...`);
			} else {
				const selected = await withCancel(
					p.multiselect({
						message: `Select skills to install ${pc.dim("(space to toggle, enter to confirm)")}`,
						options: skills.map((s) => {
							const isAnthropicBuiltIn =
								s.installedEntry?.creatorType === "anthropic";
							const label = s.installedEntry
								? isAnthropicBuiltIn
									? `${s.name} ${pc.dim("(built-in — cannot update)")}`
									: `${s.name} ${pc.dim("(already installed — will update)")}`
								: s.name;
							const hint =
								s.description.length > 70
									? `${s.description.slice(0, 70)}...`
									: s.description;
							return {
								value: s,
								label,
								hint,
								selected: !!s.installedEntry,
							};
						}),
						required: false,
					}),
				);

				toInstall = selected as typeof skills;

				if (toInstall.length === 0) {
					p.cancel("No skills selected.");
					process.exit(0);
				}
			}

			const spinner = p.spinner();
			const results: Array<{ name: string; isUpdate: boolean; error?: string }> = [];

			for (const skill of toInstall) {
				spinner.start(`Installing ${pc.cyan(skill.name)}...`);
				try {
					installSkill(skill, manifest, manifestPath);
					results.push({ name: skill.name, isUpdate: !!skill.installedEntry });
					spinner.stop(
						`${pc.green("ok")} ${skill.name} ${skill.installedEntry ? pc.dim("(updated)") : pc.dim("(new)")}`,
					);
				} catch (err) {
					results.push({ name: skill.name, isUpdate: false, error: String(err) });
					spinner.stop(`${pc.red("fail")} ${skill.name}: ${String(err)}`);
				}
			}

			const failed = results.filter((r) => r.error);
			const succeeded = results.filter((r) => !r.error);

			if (succeeded.length > 0) {
				spinner.start("Updating manifest...");
				try {
					writeManifest(manifest, manifestPath);
					spinner.stop("Manifest updated.");
				} catch (err) {
					spinner.stop("Failed to write manifest.");
					p.log.error(String(err));
				}
			}

			if (failed.length > 0) {
				p.log.warn(`${failed.length} skill(s) failed to install.`);
			}

			p.outro(
				succeeded.length > 0
					? pc.green(
							`${succeeded.length} skill(s) installed. Restart Claude Desktop to apply.`,
						)
					: pc.red("No skills installed."),
			);
		});
}
