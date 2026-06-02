import { out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { isGitRepo, readStagedDiff, readWorkingDiff, repoToplevel } from "./lib/git";
import { scoreQuery } from "./lib/similarity";
import { buildIndex, loadIndex } from "./lib/store";
import type { RegretIndex } from "./lib/types";

/** Default cosine-similarity floor below which a match is not reported. */
const DEFAULT_THRESHOLD = 0.15;

interface IndexOptions {
    since?: string;
}

interface CheckOptions {
    diff?: string;
    staged?: boolean;
    threshold: string;
    top: string;
}

async function resolveRepo(): Promise<string | null> {
    const cwd = process.cwd();
    if (!(await isGitRepo(cwd))) {
        return null;
    }

    return repoToplevel(cwd);
}

async function runIndex(options: IndexOptions): Promise<void> {
    const repo = await resolveRepo();
    if (!repo) {
        out.log.error("Not inside a git repository.");
        process.exit(1);
    }

    const spin = out.spinner();
    spin.start("Indexing bug-fix commits");
    const index = await buildIndex({ repo, since: options.since });
    spin.stop(`Indexed ${index.entries.length} bug-fix commit(s) from ${repo}`);

    out.result({ repo, entries: index.entries.length, builtAt: index.builtAt });
}

async function loadQueryDiff(repo: string, options: CheckOptions): Promise<string> {
    if (options.diff) {
        return Bun.file(options.diff).text();
    }

    if (options.staged) {
        return readStagedDiff(repo);
    }

    return readWorkingDiff(repo);
}

async function ensureIndex(repo: string): Promise<RegretIndex | null> {
    const index = await loadIndex(repo);
    if (index && index.entries.length > 0) {
        return index;
    }

    return null;
}

async function runCheck(options: CheckOptions): Promise<void> {
    const repo = await resolveRepo();
    if (!repo) {
        out.log.error("Not inside a git repository.");
        process.exit(1);
    }

    const index = await ensureIndex(repo);
    if (!index) {
        out.log.warn("No regret-grep index found (or it is empty). Run `tools regret-grep index` first.");
        out.result({ repo, matches: [] });
        return;
    }

    const queryText = await loadQueryDiff(repo, options);
    if (!queryText.trim()) {
        out.log.info("No diff to check (working tree clean or empty input).");
        out.result({ repo, matches: [] });
        return;
    }

    const threshold = Number.parseFloat(options.threshold);
    const topN = Math.max(1, Number.parseInt(options.top, 10) || 5);
    const scored = scoreQuery(queryText, index, topN).filter((m) => m.score >= threshold);

    if (scored.length === 0) {
        out.log.success("No similar past bug-fixes found above threshold.");
        out.result({ repo, matches: [] });
        return;
    }

    out.log.warn(`You fixed something like this before (${scored.length} match(es)):`);
    for (const match of scored) {
        const pct = (match.score * 100).toFixed(0);
        const overlap = match.overlap.length > 0 ? ` [${match.overlap.join(", ")}]` : "";
        out.log.message(`  ${match.entry.hash} (${match.entry.date}): ${match.entry.subject} — ${pct}%${overlap}`);
    }

    out.result({
        repo,
        matches: scored.map((m) => ({
            hash: m.entry.hash,
            date: m.entry.date,
            subject: m.entry.subject,
            score: m.score,
            overlap: m.overlap,
        })),
    });
}

const program = new Command();

program.name("regret-grep").description("Warn when the current diff repeats a bug you already fixed.");

program
    .command("index")
    .description("Build/update the local index of past bug-fix commits.")
    .option("--since <when>", "Only index commits since this git date (e.g. '6 months ago').")
    .action(async (options: IndexOptions) => {
        await runIndex(options);
    });

program
    .command("check")
    .description("Score the current diff against past bug-fixes and warn on repeats.")
    .option("--diff <file>", "Score this unified-diff file instead of the working tree.")
    .option("--staged", "Score the staged diff (git diff --cached) instead of the working tree.")
    .option("--threshold <n>", "Minimum cosine similarity to report (0-1).", String(DEFAULT_THRESHOLD))
    .option("--top <n>", "Maximum number of matches to report.", "5")
    .action(async (options: CheckOptions) => {
        await runCheck(options);
    });

await runTool(program, { tool: "regret-grep" });
