import type { BoardSummaryDto, CardDto, EdgeDto } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { printLn } from "@app/utils/cli";
import type { Command } from "commander";
import { BoardsHttpError, postJson, resolveBaseUrl } from "../lib/client";
import { captureRoot, readSetConfig, slugifyBranch } from "../lib/config";

interface ImportSetResult {
    cards: CardDto[];
    edges: EdgeDto[];
    skipped: number;
}

/** Board slugs must satisfy the server's `BOARD_SLUG_RE` (`^[a-z0-9][a-z0-9-]{0,63}$`). */
export function boardSlugFrom(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export function registerBoardFromSetCommand(program: Command): void {
    program
        .command("board-from-set")
        .description("Create (or reuse) a board and import the current shot set")
        .option("--slug <slug>", "board slug (defaults to the set key)")
        .option("--title <title>", "board title")
        .option("--dir <path>", "capture root directory")
        .option("--base <url>", "dev-dashboard base URL")
        .action(async (opts: { slug?: string; title?: string; dir?: string; base?: string }) => {
            const cwd = process.cwd();
            const root = captureRoot(cwd, opts.dir);
            const cfg = await readSetConfig(root);
            if (!cfg) {
                process.stderr.write("no set config found — run `tools boards init` first\n");
                process.exitCode = 1;
                return;
            }

            const base = resolveBaseUrl(opts.base);
            const slug = boardSlugFrom(opts.slug ?? cfg.key);
            const title = opts.title ?? cfg.title ?? cfg.key;

            try {
                await postJson<BoardSummaryDto>(base, paths.boards(), { slug, title, project: cfg.project });
            } catch (err) {
                if (!(err instanceof BoardsHttpError) || err.status !== 409) {
                    throw err;
                }
                // 409 → the board already exists; reuse it.
            }

            const result = await postJson<ImportSetResult>(base, paths.boardImportSet(slug), {
                project: cfg.project,
                branch: slugifyBranch(cfg.branch),
                selector: cfg.key,
            });

            await printLn(
                `board → ${base}/boards/${slug} (imported ${result.cards.length} cards, skipped ${result.skipped})`
            );
        });
}
