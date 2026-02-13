import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { basename } from "node:path";
import { formatRelativeTime } from "@app/utils/format";
import { detectCurrentProject, findClaudeCommand } from "@app/utils/claude";
import logger from "@app/logger";
import { getSessionMetadata } from "@app/claude-history/cache";
import {
	getSessionListing,
	rgExtractSnippet,
	rgSearchFiles,
	searchConversations,
	type SessionMetadataRecord,
} from "@app/claude-history/lib";

// --- Constants ---

const NAME_MAX_LEN = 45;
const ID_PREFIX_LEN = 8;
const PROMPT_PREVIEW_LEN = 60;

// --- Types ---

interface DisplaySession {
	sessionId: string;
	name: string;
	summary: string;
	branch: string;
	project: string;
	modified: string;
	source: "cache" | "search";
	firstPrompt: string;
	matchSnippet?: string;
}

interface Options {
	list?: boolean;
	allProjects?: boolean;
	limit: string;
}

// --- Helpers ---

function toDisplay(
	sessionId: string,
	opts: {
		title?: string | null;
		summary?: string | null;
		firstPrompt?: string | null;
		branch?: string | null;
		project?: string | null;
		timestamp?: string | null;
		source?: "cache" | "search";
		matchSnippet?: string;
	},
): DisplaySession {
	return {
		sessionId,
		name:
			opts.title ||
			opts.summary ||
			opts.firstPrompt?.slice(0, PROMPT_PREVIEW_LEN) ||
			"(unnamed)",
		summary: opts.summary || "",
		branch: opts.branch || "",
		project: opts.project || "",
		modified: opts.timestamp || "",
		source: opts.source ?? "cache",
		firstPrompt: opts.firstPrompt || "",
		matchSnippet: opts.matchSnippet,
	};
}

function formatDate(iso: string): string {
	if (!iso) return "";
	return formatRelativeTime(new Date(iso), { compact: true });
}

function dedup(sessions: DisplaySession[]): DisplaySession[] {
	const seen = new Set<string>();
	return sessions.filter((s) => {
		if (seen.has(s.sessionId)) return false;
		seen.add(s.sessionId);
		return true;
	});
}

// --- Data ---

type Spinner = ReturnType<typeof p.spinner>;

function progressUpdater(spinner: Spinner) {
	return (processed: number, total: number, file: string) => {
		const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
		const shortId = file.length > 8 ? file.slice(0, 8) : file;
		spinner.message(`${processed}/${total} (${pct}%) ${shortId}...`);
	};
}

interface LoadResult {
	sessions: DisplaySession[];
	total: number;
	subagents: number;
	project: string | undefined;
}

async function loadSessions(allProjects: boolean, spinner: Spinner): Promise<LoadResult> {
	const project = allProjects ? undefined : detectCurrentProject();
	const result = await getSessionListing({
		project,
		excludeSubagents: true,
		onProgress: progressUpdater(spinner),
	});
	return {
		sessions: result.sessions.map((s: SessionMetadataRecord) =>
			toDisplay(s.sessionId || basename(s.filePath, ".jsonl"), {
				title: s.customTitle,
				summary: s.summary,
				firstPrompt: s.firstPrompt,
				branch: s.gitBranch,
				project: s.project,
				timestamp: new Date(s.mtime).toISOString(),
			}),
		),
		total: result.total,
		subagents: result.subagents,
		project,
	};
}

function matchByIdOrName(all: DisplaySession[], query: string): DisplaySession[] {
	const q = query.toLowerCase();
	const byId = all.filter((s) => s.sessionId.toLowerCase().startsWith(q));
	if (byId.length > 0) return byId;

	return all.filter(
		(s) =>
			s.name.toLowerCase().includes(q) ||
			s.branch.toLowerCase().includes(q) ||
			s.project.toLowerCase().includes(q) ||
			s.firstPrompt.toLowerCase().includes(q),
	);
}

async function searchByContent(query: string, spinner: Spinner, project?: string): Promise<DisplaySession[]> {
	// Phase 1: Fast metadata-only search (SQLite — includes allUserText)
	const metaResults = await searchConversations({
		query,
		project,
		sortByRelevance: true,
		limit: 20,
		summaryOnly: true,
	});

	if (metaResults.length > 0) {
		return metaResults.map((r) =>
			toDisplay(r.sessionId, {
				title: r.customTitle,
				summary: r.summary,
				branch: r.gitBranch,
				project: r.project,
				timestamp: r.timestamp.toISOString(),
				source: "search",
			}),
		);
	}

	// Phase 2: ripgrep full-content search (fast, searches everything)
	spinner.message("Deep searching with rg...");
	const matchingFiles = await rgSearchFiles(query, { project, limit: 30 });

	if (matchingFiles.length === 0) return [];

	spinner.message(`Found ${matchingFiles.length} matches, loading metadata...`);

	const results: DisplaySession[] = [];
	for (const filePath of matchingFiles.slice(0, 20)) {
		const cached = getSessionMetadata(filePath);
		const snippet = await rgExtractSnippet(query, filePath);

		results.push(toDisplay(
			cached?.sessionId || basename(filePath, ".jsonl"),
			{
				title: cached?.customTitle,
				summary: cached?.summary,
				firstPrompt: cached?.firstPrompt,
				branch: cached?.gitBranch,
				project: cached?.project,
				timestamp: cached?.firstTimestamp || new Date(0).toISOString(),
				source: "search",
				matchSnippet: snippet,
			},
		));
	}

	return results;
}

// --- UI ---

const EXCERPT_MAX_LEN = 120;

/**
 * Build a conversation excerpt line that adds context beyond the session name.
 * Priority: matchSnippet > summary (if name isn't summary) > firstPrompt (if name isn't firstPrompt).
 */
function buildExcerpt(s: DisplaySession): string | undefined {
	if (s.matchSnippet) return s.matchSnippet;

	const nameNorm = s.name.toLowerCase().trim();

	// If name came from custom title → show summary or first prompt
	if (s.summary && s.summary.toLowerCase().trim() !== nameNorm) {
		return s.summary;
	}

	// If name came from summary → show first prompt
	const promptPreview = s.firstPrompt.slice(0, PROMPT_PREVIEW_LEN);
	if (s.firstPrompt && promptPreview.toLowerCase().trim() !== nameNorm) {
		return s.firstPrompt;
	}

	return undefined;
}

function sessionOption(s: DisplaySession) {
	const hints = [
		pc.dim(s.sessionId.slice(0, ID_PREFIX_LEN)),
		s.branch ? pc.magenta(s.branch) : "",
		s.project ? pc.blue(s.project) : "",
		pc.dim(formatDate(s.modified)),
		s.source === "search" ? pc.yellow("[search]") : "",
	].filter(Boolean);

	const excerpt = buildExcerpt(s);
	let label = s.name.slice(0, NAME_MAX_LEN);
	if (excerpt) {
		const cleaned = excerpt.slice(0, EXCERPT_MAX_LEN).replace(/\n/g, " ").trim();
		label += `\n  ${pc.dim(cleaned)}`;
	}

	return {
		value: s,
		label,
		hint: hints.join(" "),
	};
}

async function selectSession(candidates: DisplaySession[]): Promise<DisplaySession> {
	if (candidates.length === 1) {
		const s = candidates[0];
		p.log.info(
			`${pc.bold(s.name)} ${pc.dim(s.sessionId.slice(0, ID_PREFIX_LEN))} ${pc.magenta(s.branch)} ${pc.dim(formatDate(s.modified))}`,
		);
		return s;
	}

	const result = await p.select({
		message: "Select session to resume:",
		options: candidates.map(sessionOption),
	});

	if (p.isCancel(result)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return result;
}

async function resumeSession(session: DisplaySession): Promise<never> {
	// Validate sessionId to prevent shell injection
	if (!/^[\w-]+$/.test(session.sessionId)) {
		throw new Error(`Invalid session ID: ${session.sessionId}`);
	}

	const cmd = await findClaudeCommand();
	p.outro(`${pc.green("Resuming:")} ${cmd} --resume ${session.sessionId}`);

	const shell = process.env.SHELL || "/bin/sh";
	const proc = Bun.spawn({
		cmd: [shell, "-ic", `exec ${cmd} --resume '${session.sessionId}'`],
		stdio: ["inherit", "inherit", "inherit"],
	});

	const exitCode = await proc.exited;
	process.exit(exitCode);
}

// --- Main ---

async function main(query: string | undefined, opts: Options) {
	p.intro(pc.bgCyan(pc.black(" claude-resume ")));
	const limit = parseInt(opts.limit, 10) || 20;

	const spinner = p.spinner();
	spinner.start("Loading sessions...");
	const { sessions, total, subagents, project } = await loadSessions(opts.allProjects ?? false, spinner);
	const statsLine = subagents > 0
		? `${sessions.length} sessions (+ ${subagents} subagents, total ${total})`
		: `${sessions.length} sessions`;
	spinner.stop(statsLine);

	if (sessions.length === 0) {
		p.log.error("No sessions found");
		process.exit(1);
	}

	let candidates: DisplaySession[];

	if (!query || opts.list) {
		candidates = sessions.slice(0, limit);
	} else {
		candidates = matchByIdOrName(sessions, query);

		if (candidates.length === 0) {
			p.log.info(`No index match for "${query}", searching content...`);
			const searchSpinner = p.spinner();
			searchSpinner.start("Searching...");
			const found = await searchByContent(query, searchSpinner, project);
			searchSpinner.stop(found.length ? `${found.length} matches` : "No matches");

			if (found.length > 0) {
				candidates = dedup(
					found.map((h) => {
						const indexed = sessions.find((s) => s.sessionId === h.sessionId);
						return indexed ? { ...indexed, source: "search" as const } : h;
					}),
				);
			}
		}

		if (candidates.length === 0) {
			p.log.warn("No matches. Showing recent:");
			candidates = sessions.slice(0, limit);
		}
	}

	const selected = await selectSession(candidates);
	await resumeSession(selected);
}

// --- CLI ---

const program = new Command();

program
	.name("claude-resume")
	.description("Resume a Claude Code session by short ID, name, or content search")
	.argument("[query]", "Session ID prefix, name, or search term")
	.option("-l, --list", "List recent sessions")
	.option("-a, --all-projects", "Search all projects (default: current project only)")
	.option("-n, --limit <n>", "Number of sessions to show", "20")
	.action(async (query: string | undefined, opts: Options) => {
		try {
			await main(query, opts);
		} catch (error) {
			if (error instanceof Error && (error.name === "ExitPromptError" || error.message === "Cancelled")) {
				process.exit(0);
			}
			logger.error(`claude-resume error: ${error}`);
			p.log.error(String(error));
			process.exit(1);
		}
	});

program.parse();
