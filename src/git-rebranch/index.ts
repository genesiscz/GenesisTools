import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { handleReadmeFlag } from "@app/utils/readme";
import { createGit } from "@app/utils/git";
import type { DetailedCommitInfo } from "@app/utils/git";
import { searchMultiselect, cancelSymbol } from "@app/utils/prompts/clack/search-multiselect";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { parseCommit, groupCommits } from "./grouping";
import type { CommitGroup, BranchResult } from "./types";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

interface Options {
	helpFull?: boolean;
	dryRun?: boolean;
	verbose?: boolean;
}

function showHelpFull() {
	console.log(`
Usage: tools git-rebranch [options]

Description:
  Split a messy branch with mixed commits into multiple clean branches.
  Automatically groups commits by conventional commit scope/ticket,
  lets you refine the grouping interactively, then creates new branches
  via cherry-pick from the detected fork point.

Options:
  --dry-run       Show execution plan without creating branches
  -v, --verbose   Show git commands being executed
  -?, --help-full Show this detailed help message

Workflow:
  1. Detects your current branch and its fork point
  2. Parses commits using conventional commit format
  3. Groups commits by scope/ticket (e.g., COL-123)
  4. Lets you refine groups with searchable multiselect
  5. Names each group → becomes the new branch name
  6. Cherry-picks commits onto new branches from fork point

Examples:
  tools git-rebranch              # Interactive mode
  tools git-rebranch --dry-run    # Preview without creating branches
  tools git-rebranch --verbose    # Show all git commands
`);
}

function slugify(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

const program = new Command()
	.name("git-rebranch")
	.description("Split a messy branch into multiple clean branches by commit grouping")
	.option("-?, --help-full", "Show detailed help message")
	.option("--dry-run", "Show execution plan without creating branches")
	.option("-v, --verbose", "Show git commands being executed")
	.parse();

const opts = program.opts<Options>();

if (opts.helpFull) {
	showHelpFull();
	process.exit(0);
}

async function main(): Promise<void> {
	const git = createGit({ verbose: opts.verbose ?? false });

	p.intro(pc.bgCyan(pc.black(" git-rebranch ")));

	// === STEP 1: Precondition checks ===
	if (await git.hasUncommittedChanges()) {
		p.cancel("Working tree has uncommitted changes. Please commit or stash them first.");
		process.exit(1);
	}
	if (await git.isRebaseInProgress()) {
		p.cancel("A rebase is in progress. Please finish or abort it first.");
		process.exit(1);
	}
	if (await git.isGitLocked()) {
		p.cancel("Git repository is locked (.git/index.lock exists). Another git process may be running.");
		process.exit(1);
	}

	// === STEP 2: Identify source branch ===
	const currentBranch = await git.getCurrentBranch();
	if (currentBranch === "HEAD") {
		p.cancel("Detached HEAD state. Please checkout a branch first.");
		process.exit(1);
	}

	const branches = await git.getBranches();
	const branchOptions = branches.map((b) => ({
		value: b.name,
		label: b.name + (b.isCurrent ? pc.dim(" (current)") : ""),
	}));
	const sourceBranch = (await withCancel(
		p.select({
			message: `Which branch to split? (current: ${pc.cyan(currentBranch)})`,
			options: branchOptions,
			initialValue: currentBranch,
		}),
	)) as string;

	// === STEP 3: Detect base branch and fork point ===
	const { baseBranch, forkPointSha } = await detectForkPoint(git, sourceBranch);

	// === STEP 4: Parse and display commits ===
	const commits = await git.getDetailedCommits(forkPointSha, sourceBranch);
	if (commits.length === 0) {
		p.cancel("No commits found between fork point and branch HEAD.");
		process.exit(1);
	}

	p.log.info(
		`Found ${pc.bold(String(commits.length))} commit(s) on ${pc.cyan(sourceBranch)} since ${pc.cyan(baseBranch)}`,
	);

	// === STEP 5: Parse and group commits ===
	const parsed = commits.map(parseCommit);
	let groups = groupCommits(parsed);

	// Show auto-detected groups
	for (const group of groups) {
		p.log.step(`${pc.bold(group.label)} (${group.commits.length} commits)`);
		for (const c of group.commits) {
			p.log.message(`  ${pc.dim(c.commit.shortHash)} ${c.commit.message}`);
		}
	}

	// === STEP 6: Ask about commit exclusivity ===
	const allowDuplicates = await withCancel(
		p.select({
			message: "Can a commit appear in multiple new branches?",
			options: [
				{
					value: false as const,
					label: "No, each commit goes to exactly one branch",
					hint: "exclusive",
				},
				{
					value: true as const,
					label: "Yes, commits can be cherry-picked into multiple branches",
					hint: "shared",
				},
			],
			initialValue: false as const,
		}),
	);

	// === STEP 7: Interactive group refinement ===
	groups = await refineGroups(groups, allowDuplicates, commits);

	// Filter out empty groups
	groups = groups.filter((g) => g.commits.length > 0);
	if (groups.length === 0) {
		p.cancel("No commits assigned to any group.");
		process.exit(1);
	}

	// === STEP 8: Name each group (branch names) ===
	await nameGroups(git, groups, sourceBranch);

	// === STEP 9: Show summary and confirm ===
	displaySummary(groups, baseBranch, forkPointSha);

	if (opts.dryRun) {
		p.outro(pc.cyan("[Dry run] No branches created."));
		process.exit(0);
	}

	const confirmed = await withCancel(
		p.confirm({
			message: "Create these branches?",
		}),
	);
	if (!confirmed) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	// === STEP 10: Execute cherry-picks ===
	const results = await executeBranches(git, groups, forkPointSha);

	// === STEP 11: Show results and return to original branch ===
	displayResults(results);

	await git.checkout(currentBranch);
	p.outro(pc.green(`Done! Returned to ${currentBranch}`));
}

// ─── Helper Functions ────────────────────────────────────────────────

type GitInstance = ReturnType<typeof createGit>;

async function detectForkPoint(
	git: GitInstance,
	sourceBranch: string,
): Promise<{ baseBranch: string; forkPointSha: string }> {
	const branches = await git.getBranches();
	const candidates = branches.filter((b) => b.name !== sourceBranch).map((b) => b.name);

	const commonBases = ["master", "main", "develop"];
	let bestBase: string | null = null;
	let bestForkSha: string | null = null;
	let bestCommitCount = Infinity;

	const spinner = p.spinner();
	spinner.start("Detecting fork point...");

	for (const candidate of candidates) {
		try {
			const mb = await git.mergeBase(sourceBranch, candidate);
			const count = await git.countCommits(mb, sourceBranch);
			if (count <= 0) continue;

			const isCommon = commonBases.includes(candidate);
			// Prefer the candidate that gives us the fewest commits
			// (closest parent). Break ties by preferring common base branches.
			if (count < bestCommitCount || (count === bestCommitCount && isCommon && !commonBases.includes(bestBase!))) {
				bestBase = candidate;
				bestForkSha = mb;
				bestCommitCount = count;
			}
		} catch {
			continue;
		}
	}

	if (!bestBase || !bestForkSha) {
		spinner.stop(pc.red("Could not detect fork point"));
		p.cancel("Could not detect a fork point. Make sure you have a base branch.");
		process.exit(1);
	}

	spinner.stop(
		`Detected: ${pc.cyan(sourceBranch)} forked from ${pc.cyan(bestBase)} (${bestCommitCount} commits, at ${pc.dim(bestForkSha.substring(0, 7))})`,
	);

	const useDetected = await withCancel(
		p.confirm({
			message: `Use ${pc.cyan(bestBase)} as the base branch?`,
			initialValue: true,
		}),
	);

	if (!useDetected) {
		const selectedBase = await withCancel(
			p.select({
				message: "Select base branch:",
				options: candidates.map((c) => ({ value: c, label: c })),
			}),
		);
		const newForkSha = await git.mergeBase(sourceBranch, selectedBase);
		return { baseBranch: selectedBase, forkPointSha: newForkSha };
	}

	return { baseBranch: bestBase, forkPointSha: bestForkSha };
}

async function refineGroups(
	groups: CommitGroup[],
	allowDuplicates: boolean,
	allCommits: DetailedCommitInfo[],
): Promise<CommitGroup[]> {
	const assignedCommitHashes = new Set<string>();
	const refinedGroups: CommitGroup[] = [];

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];

		// Build items from all available commits for this group
		let availableCommits = group.commits;
		if (!allowDuplicates) {
			availableCommits = availableCommits.filter((c) => !assignedCommitHashes.has(c.commit.hash));
		}

		if (availableCommits.length === 0) {
			p.log.warn(`Group "${group.label}" has no remaining commits, skipping.`);
			continue;
		}

		p.log.step(`Group ${i + 1}/${groups.length}: ${pc.bold(group.label)}`);

		// Build items list: group's commits are pre-selected, others available
		const groupHashes = new Set(availableCommits.map((c) => c.commit.hash));

		// Also include commits not in this group that haven't been assigned (if not exclusive)
		// This lets users pull commits from other groups or ungrouped
		const allParsed = allCommits
			.filter((c) => {
				if (!allowDuplicates && assignedCommitHashes.has(c.hash)) return false;
				return true;
			})
			.map((c) => {
				const existing = availableCommits.find((ac) => ac.commit.hash === c.hash);
				if (existing) return existing;
				return parseCommit(c);
			});

		const items = allParsed.map((c) => ({
			value: c,
			label: `${pc.dim(c.commit.shortHash)} ${c.commit.message}`,
			hint: c.type ?? undefined,
		}));

		const initialSelected = allParsed.filter((c) => groupHashes.has(c.commit.hash));

		const selected = await searchMultiselect({
			message: `Select commits for "${group.label}"`,
			items,
			initialSelected,
			maxVisible: 12,
		});

		if (selected === cancelSymbol) {
			p.cancel("Operation cancelled.");
			process.exit(0);
		}

		const selectedCommits = selected as (typeof allParsed)[number][];

		if (selectedCommits.length === 0) {
			p.log.warn(`No commits selected for "${group.label}", skipping this group.`);
			continue;
		}

		if (!allowDuplicates) {
			for (const c of selectedCommits) {
				assignedCommitHashes.add(c.commit.hash);
			}
		}

		refinedGroups.push({
			...group,
			commits: selectedCommits,
		});
	}

	return refinedGroups;
}

async function nameGroups(git: GitInstance, groups: CommitGroup[], sourceBranch: string): Promise<void> {
	// Try to extract a prefix from the source branch (e.g., "feature/" from "feature/messy-branch")
	const slashIndex = sourceBranch.lastIndexOf("/");
	const defaultPrefix = slashIndex > 0 ? sourceBranch.substring(0, slashIndex + 1) : "";

	for (const group of groups) {
		const suggestion = defaultPrefix + slugify(group.label);

		const branchName = await withCancel(
			p.text({
				message: `Branch name for "${group.label}" (${group.commits.length} commits):`,
				placeholder: suggestion,
				defaultValue: suggestion,
				validate: (value: string | undefined) => {
					if (!value?.trim()) return "Branch name cannot be empty.";
					if (/[~^: \\]/.test(value)) return "Invalid characters in branch name.";
					return undefined;
				},
			}),
		);

		group.branchName = branchName;
	}

	// Validate no duplicate branch names
	const names = groups.map((g) => g.branchName!);
	const dupes = names.filter((n, i) => names.indexOf(n) !== i);
	if (dupes.length > 0) {
		p.cancel(`Duplicate branch names: ${dupes.join(", ")}`);
		process.exit(1);
	}

	// Validate no branch name conflicts with existing branches
	for (const group of groups) {
		if (await git.branchExists(group.branchName!)) {
			p.cancel(`Branch "${group.branchName}" already exists.`);
			process.exit(1);
		}
	}
}

function displaySummary(groups: CommitGroup[], baseBranch: string, forkPointSha: string): void {
	const lines: string[] = [];
	lines.push(`Base: ${baseBranch} (${forkPointSha.substring(0, 7)})\n`);

	for (const group of groups) {
		lines.push(`${pc.bold(group.branchName!)} (${group.commits.length} commits)`);
		for (const c of group.commits) {
			lines.push(`  ${pc.dim(c.commit.shortHash)} ${c.commit.message}`);
		}
		lines.push("");
	}

	p.note(lines.join("\n"), "Execution Plan");
}

async function executeBranches(
	git: GitInstance,
	groups: CommitGroup[],
	forkPointSha: string,
): Promise<BranchResult[]> {
	const results: BranchResult[] = [];
	const spinner = p.spinner();

	for (const group of groups) {
		const branchName = group.branchName!;
		spinner.start(`Creating ${branchName}...`);

		const result: BranchResult = {
			branchName,
			commitsApplied: 0,
			commitsFailed: 0,
			success: true,
			errors: [],
		};

		try {
			await git.createBranch(branchName, forkPointSha);

			for (const parsedCommit of group.commits) {
				const cpResult = await git.cherryPick(parsedCommit.commit.hash);

				if (cpResult.success) {
					result.commitsApplied++;
				} else {
					result.commitsFailed++;
					result.errors.push(`Cherry-pick failed for ${parsedCommit.commit.shortHash}: ${cpResult.stderr}`);

					try {
						await git.cherryPickAbort();
					} catch {
						/* ignore */
					}

					p.log.warn(
						`Conflict on ${pc.dim(parsedCommit.commit.shortHash)} in ${branchName}. Skipped this commit.`,
					);
				}
			}

			if (result.commitsFailed > 0 && result.commitsApplied === 0) {
				result.success = false;
			}
		} catch (err) {
			result.success = false;
			result.errors.push(String(err));
		}

		const statusMsg = result.success
			? `${branchName}: ${result.commitsApplied} commits applied`
			: `${branchName}: FAILED (${result.errors.length} errors)`;
		spinner.stop(result.success ? pc.green(statusMsg) : pc.red(statusMsg));

		results.push(result);
	}

	return results;
}

function displayResults(results: BranchResult[]): void {
	const lines: string[] = [];

	for (const r of results) {
		const status = r.success ? pc.green("OK") : pc.red("FAIL");
		lines.push(`${status} ${r.branchName}: ${r.commitsApplied} applied, ${r.commitsFailed} failed`);
		for (const err of r.errors) {
			lines.push(`  ${pc.dim(err)}`);
		}
	}

	p.note(lines.join("\n"), "Results");
}

main().catch((err) => {
	p.log.error(pc.red(String(err)));
	process.exit(1);
});
