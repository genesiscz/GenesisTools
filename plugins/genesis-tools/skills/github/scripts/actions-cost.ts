#!/usr/bin/env bun

/**
 * GitHub Actions Cost Estimator
 *
 * Calculates billable minutes and estimated cost from job-level timing data.
 * Uses `gh` CLI for all API calls (reuses existing auth).
 *
 * Usage:
 *   bun actions-cost.ts --repo owner/repo --date 2026-03-12
 *   bun actions-cost.ts --org myorg --date 2026-03-12 --cross-repo
 */

import { parseArgs } from "util";

// --- Types ---

interface RunInfo {
	databaseId: number;
	workflowName: string;
	conclusion: string;
	createdAt: string;
	headBranch: string;
	event: string;
	repo: string;
}

interface JobInfo {
	name: string;
	conclusion: string;
	startedAt: string | null;
	completedAt: string | null;
	labels: string[];
}

interface RunCost {
	run: RunInfo;
	jobs: number;
	billableMinutes: number;
	estimatedCost: number;
	runnerBreakdown: Record<string, number>;
	durations: number[];
}

interface WorkflowSummary {
	workflow: string;
	runs: number;
	success: number;
	failure: number;
	cancelled: number;
	billableMinutes: number;
	estimatedCost: number;
	durations: number[];
}

// --- Runner rates ($/min) ---

const RUNNER_RATES: Record<string, number> = {
	linux: 0.008,
	"linux-4": 0.016,
	"linux-8": 0.032,
	"linux-16": 0.064,
	windows: 0.016,
	macos: 0.08,
	"macos-xlarge": 0.12,
};

// --- CLI Parsing ---

function parseCliArgs() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			repo: { type: "string" },
			org: { type: "string" },
			date: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			branch: { type: "string" },
			workflow: { type: "string" },
			"cross-repo": { type: "boolean", default: false },
			top: { type: "string", default: "10" },
			format: { type: "string", default: "table" },
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		strict: true,
	});

	if (values.help || (!values.repo && !values.org)) {
		printHelp();
		process.exit(values.help ? 0 : 1);
	}

	if (values["cross-repo"] && !values.org) {
		console.error("Error: --cross-repo requires --org");
		process.exit(1);
	}

	if (!values.date && !values.from) {
		console.error("Error: provide --date or --from (optionally with --to)");
		process.exit(1);
	}

	return values;
}

function printHelp() {
	console.log(`GitHub Actions Cost Estimator

Usage:
  bun actions-cost.ts [options]

Options:
  --repo <owner/repo>     Single repo to analyze
  --org <org>             Org to scan (with --cross-repo)
  --date <YYYY-MM-DD>     Single date
  --from <YYYY-MM-DD>     Start of date range
  --to <YYYY-MM-DD>       End of date range (default: today)
  --branch <branch>       Filter runs by branch
  --workflow <name>       Filter by workflow name
  --cross-repo            Scan all repos in org (requires --org)
  --top <n>               Show top N most expensive runs (default: 10)
  --format <table|json>   Output format (default: table)
  --verbose               Show progress during cross-repo scan
  --help                  Show this help

Examples:
  bun actions-cost.ts --repo owner/repo --date 2026-03-12
  bun actions-cost.ts --org myorg --date 2026-03-12 --cross-repo --verbose
  bun actions-cost.ts --repo owner/repo --from 2026-03-01 --to 2026-03-07 --branch main`);
}

// --- gh CLI helpers ---

async function gh(args: string[]): Promise<string> {
	const proc = Bun.spawn(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new Error(`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}

	return stdout.trim();
}

async function ghJson<T>(args: string[]): Promise<T> {
	const raw = await gh(args);

	if (!raw) {
		return [] as unknown as T;
	}

	return JSON.parse(raw) as T;
}

// --- Core Logic ---

function detectRunnerType(labels: string[]): string {
	for (const label of labels) {
		const l = label.toLowerCase();

		if (l.includes("macos") && l.includes("xlarge")) {
			return "macos-xlarge";
		}

		if (l.includes("macos")) {
			return "macos";
		}

		if (l.includes("windows")) {
			return "windows";
		}

		if (l.includes("ubuntu") || l.includes("linux")) {
			const coreMatch = l.match(/(\d+)-core/);

			if (coreMatch) {
				const cores = parseInt(coreMatch[1]);

				if (cores >= 16) {
					return "linux-16";
				}

				if (cores >= 8) {
					return "linux-8";
				}

				if (cores >= 4) {
					return "linux-4";
				}
			}

			return "linux";
		}
	}

	return "linux"; // default fallback
}

function getRate(runnerType: string): number {
	return RUNNER_RATES[runnerType] ?? RUNNER_RATES.linux;
}

async function listOrgRepos(org: string): Promise<string[]> {
	const repos = await ghJson<Array<{ nameWithOwner: string }>>(
		["repo", "list", org, "--json", "nameWithOwner", "--limit", "100"]
	);

	return repos.map(r => r.nameWithOwner);
}

async function listRuns(
	repo: string,
	opts: { created: string; branch?: string; workflow?: string }
): Promise<RunInfo[]> {
	const args = [
		"run", "list",
		"--repo", repo,
		"--created", opts.created,
		"--limit", "500",
		"--json", "databaseId,workflowName,conclusion,createdAt,headBranch,event",
	];

	if (opts.branch) {
		args.push("--branch", opts.branch);
	}

	if (opts.workflow) {
		args.push("--workflow", opts.workflow);
	}

	const runs = await ghJson<RunInfo[]>(args);
	return runs.map(r => ({ ...r, repo }));
}

async function getRunJobs(repo: string, runId: number): Promise<JobInfo[]> {
	const result = await ghJson<{ jobs: JobInfo[] }>(
		["run", "view", String(runId), "--repo", repo, "--json", "jobs"]
	);

	return result.jobs ?? [];
}

function calculateRunCost(run: RunInfo, jobs: JobInfo[]): RunCost {
	let billableMinutes = 0;
	let estimatedCost = 0;
	const runnerBreakdown: Record<string, number> = {};
	const durations: number[] = [];
	let jobCount = 0;

	for (const job of jobs) {
		// Skip jobs without valid timestamps (skipped/pending)
		if (!job.startedAt || !job.completedAt) {
			continue;
		}

		const validConclusions = ["success", "failure", "cancelled"];

		if (!validConclusions.includes(job.conclusion)) {
			continue;
		}

		const startMs = new Date(job.startedAt).getTime();
		const endMs = new Date(job.completedAt).getTime();
		const durationSec = Math.max(0, (endMs - startMs) / 1000);
		const billMin = Math.ceil(durationSec / 60);
		const runnerType = detectRunnerType(job.labels ?? []);
		const rate = getRate(runnerType);
		const cost = billMin * rate;

		billableMinutes += billMin;
		estimatedCost += cost;
		runnerBreakdown[runnerType] = (runnerBreakdown[runnerType] ?? 0) + billMin;
		durations.push(durationSec);
		jobCount++;
	}

	return {
		run,
		jobs: jobCount,
		billableMinutes,
		estimatedCost,
		runnerBreakdown,
		durations,
	};
}

// --- Output Formatting ---

function formatTable(
	workflows: WorkflowSummary[],
	topRuns: RunCost[],
	failureWaste: { count: number; minutes: number; cost: number; fastFails: number; fullFails: number },
	dateRange: string,
	topN: number
) {
	const totalRuns = workflows.reduce((s, w) => s + w.runs, 0);
	const totalSuccess = workflows.reduce((s, w) => s + w.success, 0);
	const totalFailed = workflows.reduce((s, w) => s + w.failure, 0);
	const totalMinutes = workflows.reduce((s, w) => s + w.billableMinutes, 0);
	const totalCost = workflows.reduce((s, w) => s + w.estimatedCost, 0);

	// Header
	console.log(`\nGitHub Actions Cost Report — ${dateRange}\n`);

	// Workflow table
	const nameWidth = Math.max(20, ...workflows.map(w => w.workflow.length)) + 2;
	const header = [
		"Workflow".padEnd(nameWidth),
		"Runs".padStart(6),
		"Pass".padStart(6),
		"Fail".padStart(6),
		"Bill.Min".padStart(10),
		"Est. $".padStart(10),
	].join(" | ");

	const sep = header.replace(/[^|]/g, "-");

	console.log(header);
	console.log(sep);

	for (const w of workflows.sort((a, b) => b.estimatedCost - a.estimatedCost)) {
		console.log([
			w.workflow.padEnd(nameWidth),
			String(w.runs).padStart(6),
			String(w.success).padStart(6),
			String(w.failure).padStart(6),
			w.billableMinutes.toLocaleString().padStart(10),
			`$${w.estimatedCost.toFixed(2)}`.padStart(10),
		].join(" | "));
	}

	console.log(sep);
	console.log([
		"TOTAL".padEnd(nameWidth),
		String(totalRuns).padStart(6),
		String(totalSuccess).padStart(6),
		String(totalFailed).padStart(6),
		totalMinutes.toLocaleString().padStart(10),
		`$${totalCost.toFixed(2)}`.padStart(10),
	].join(" | "));

	// Workflow efficiency
	console.log(`\nWorkflow Efficiency:`);

	for (const w of workflows.sort((a, b) => b.runs - a.runs)) {
		if (w.durations.length === 0) {
			continue;
		}

		const sorted = [...w.durations].sort((a, b) => a - b);
		const avg = sorted.reduce((s, d) => s + d, 0) / sorted.length;
		const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
		const successRate = w.runs > 0 ? ((w.success / w.runs) * 100).toFixed(0) : "N/A";

		console.log(`  ${w.workflow}: avg ${formatDuration(avg)}, p90 ${formatDuration(p90)}, success ${successRate}%`);
	}

	// Top N runs
	if (topRuns.length > 0) {
		console.log(`\nTop ${Math.min(topN, topRuns.length)} Most Expensive Runs:`);

		for (let i = 0; i < Math.min(topN, topRuns.length); i++) {
			const r = topRuns[i];
			const totalDur = r.durations.reduce((s, d) => s + d, 0);
			console.log(
				`  ${i + 1}. ${r.run.workflowName} #${r.run.databaseId} (${r.run.conclusion}) — ` +
				`${r.billableMinutes} min, $${r.estimatedCost.toFixed(2)}, ` +
				`${r.jobs} jobs, ${formatDuration(totalDur)} wall`
			);
		}
	}

	// Failure waste
	if (failureWaste.count > 0) {
		console.log(
			`\nFailure Waste: ${failureWaste.count} failed runs consumed ` +
			`${failureWaste.minutes.toLocaleString()} min ($${failureWaste.cost.toFixed(2)})`
		);

		if (failureWaste.fullFails > 0) {
			console.log(`  - ${failureWaste.fullFails} full-suite failures (>5 min each)`);
		}

		if (failureWaste.fastFails > 0) {
			console.log(`  - ${failureWaste.fastFails} fast failures (<5 min each)`);
		}

		const pct = totalCost > 0 ? ((failureWaste.cost / totalCost) * 100).toFixed(0) : "0";
		console.log(`  - ${pct}% of total spend wasted on failures`);
	}

	console.log();
}

function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${Math.round(seconds)}s`;
	}

	const min = Math.floor(seconds / 60);
	const sec = Math.round(seconds % 60);
	return sec > 0 ? `${min}m${sec}s` : `${min}m`;
}

function formatJson(
	workflows: WorkflowSummary[],
	topRuns: RunCost[],
	failureWaste: { count: number; minutes: number; cost: number },
	dateRange: string
) {
	const summary = {
		dateRange,
		totalRuns: workflows.reduce((s, w) => s + w.runs, 0),
		totalBillableMinutes: workflows.reduce((s, w) => s + w.billableMinutes, 0),
		totalEstimatedCost: workflows.reduce((s, w) => s + w.estimatedCost, 0),
	};

	const output = {
		summary,
		workflows: workflows.map(w => ({
			workflow: w.workflow,
			runs: w.runs,
			success: w.success,
			failure: w.failure,
			cancelled: w.cancelled,
			billableMinutes: w.billableMinutes,
			estimatedCost: w.estimatedCost,
			successRate: w.runs > 0 ? +(w.success / w.runs * 100).toFixed(1) : 0,
		})),
		topRuns: topRuns.map(r => ({
			id: r.run.databaseId,
			workflow: r.run.workflowName,
			conclusion: r.run.conclusion,
			branch: r.run.headBranch,
			jobs: r.jobs,
			billableMinutes: r.billableMinutes,
			estimatedCost: r.estimatedCost,
			repo: r.run.repo,
		})),
		failureWaste,
	};

	console.log(JSON.stringify(output, null, 2));
}

// --- Main ---

async function main() {
	const flags = parseCliArgs();

	// Build date filter
	let created: string;
	let dateRange: string;

	if (flags.date) {
		created = flags.date;
		dateRange = flags.date;
	} else {
		const to = flags.to ?? new Date().toISOString().slice(0, 10);
		created = `${flags.from}..${to}`;
		dateRange = `${flags.from} to ${to}`;
	}

	// Determine repos to scan
	let repos: string[];

	if (flags["cross-repo"]) {
		if (flags.verbose) {
			process.stderr.write("Discovering repos...\n");
		}

		repos = await listOrgRepos(flags.org!);

		if (flags.verbose) {
			process.stderr.write(`Found ${repos.length} repos\n`);
		}
	} else if (flags.repo) {
		repos = [flags.repo];
	} else {
		// org without --cross-repo — need a repo
		console.error("Error: provide --repo or use --cross-repo with --org");
		process.exit(1);
	}

	// Collect all runs across repos
	const allRunCosts: RunCost[] = [];
	const workflowMap = new Map<string, WorkflowSummary>();

	for (const repo of repos) {
		if (flags.verbose) {
			process.stderr.write(`\rScanning ${repo}...`);
		}

		let runs: RunInfo[];

		try {
			runs = await listRuns(repo, {
				created,
				branch: flags.branch,
				workflow: flags.workflow,
			});
		} catch (err) {
			if (flags.verbose) {
				process.stderr.write(`\n  Skipping ${repo}: ${(err as Error).message}\n`);
			}

			continue;
		}

		if (runs.length === 0) {
			continue;
		}

		if (flags.verbose) {
			process.stderr.write(`\r${repo}: ${runs.length} runs, fetching job details...\n`);
		}

		for (let i = 0; i < runs.length; i++) {
			const run = runs[i];

			if (flags.verbose && (i + 1) % 10 === 0) {
				process.stderr.write(`\r  ${repo}: ${i + 1}/${runs.length} runs processed`);
			}

			let jobs: JobInfo[];

			try {
				jobs = await getRunJobs(repo, run.databaseId);
			} catch {
				continue;
			}

			const cost = calculateRunCost(run, jobs);
			allRunCosts.push(cost);

			// Update workflow summary
			const key = `${repo}::${run.workflowName}`;
			const existing = workflowMap.get(key);

			if (existing) {
				existing.runs++;
				existing.billableMinutes += cost.billableMinutes;
				existing.estimatedCost += cost.estimatedCost;
				existing.durations.push(...cost.durations);

				if (run.conclusion === "success") {
					existing.success++;
				} else if (run.conclusion === "failure") {
					existing.failure++;
				} else if (run.conclusion === "cancelled") {
					existing.cancelled++;
				}
			} else {
				workflowMap.set(key, {
					workflow: repos.length > 1 ? `${repo.split("/")[1]}/${run.workflowName}` : run.workflowName,
					runs: 1,
					success: run.conclusion === "success" ? 1 : 0,
					failure: run.conclusion === "failure" ? 1 : 0,
					cancelled: run.conclusion === "cancelled" ? 1 : 0,
					billableMinutes: cost.billableMinutes,
					estimatedCost: cost.estimatedCost,
					durations: [...cost.durations],
				});
			}
		}

		if (flags.verbose) {
			process.stderr.write("\n");
		}
	}

	if (allRunCosts.length === 0) {
		console.log(`No workflow runs found for ${dateRange}`);
		process.exit(0);
	}

	// Sort top runs by cost
	const topRuns = [...allRunCosts]
		.sort((a, b) => b.estimatedCost - a.estimatedCost)
		.slice(0, parseInt(flags.top ?? "10"));

	// Failure waste analysis
	const failedRuns = allRunCosts.filter(r => r.run.conclusion === "failure");
	const failureWaste = {
		count: failedRuns.length,
		minutes: failedRuns.reduce((s, r) => s + r.billableMinutes, 0),
		cost: failedRuns.reduce((s, r) => s + r.estimatedCost, 0),
		fastFails: failedRuns.filter(r => r.billableMinutes < 5).length,
		fullFails: failedRuns.filter(r => r.billableMinutes >= 5).length,
	};

	const workflows = [...workflowMap.values()];
	const topN = parseInt(flags.top ?? "10");

	if (flags.format === "json") {
		formatJson(workflows, topRuns, failureWaste, dateRange);
	} else {
		formatTable(workflows, topRuns, failureWaste, dateRange, topN);
	}
}

main().catch(err => {
	console.error(`Error: ${err.message}`);
	process.exit(1);
});
