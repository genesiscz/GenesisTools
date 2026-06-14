import { resolve } from "node:path";
import { logger, out } from "@app/logger";
import { runTool, suggestCommand } from "@app/utils/cli";
import clipboardy from "clipboardy";
import { Command } from "commander";
import { packByBudget } from "./lib/pack";
import { rankFiles } from "./lib/rank";
import { type IncludedFile, renderJson, renderTree } from "./lib/render";
import { type ScannedFileWithTokens, scanRepo } from "./lib/scanner";

interface Options {
    maxTokens: string;
    lang?: string[];
    json?: boolean;
    filesOnly?: boolean;
    clipboard?: boolean;
}

const LANG_ALIAS: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    python: "python",
    go: "go",
    rs: "rust",
    rust: "rust",
    typescript: "typescript",
    javascript: "javascript",
};

/** Normalize --lang values (comma-separated and/or repeated) to a set of names. */
function parseLanguages(values: string[] | undefined): Set<string> | null {
    if (!values || values.length === 0) {
        return null;
    }

    const set = new Set<string>();

    for (const raw of values) {
        for (const part of raw.split(",")) {
            const key = part.trim().toLowerCase();

            if (key && LANG_ALIAS[key]) {
                set.add(LANG_ALIAS[key]);
            }
        }
    }

    return set.size > 0 ? set : null;
}

async function main(dirArg: string | undefined, options: Options): Promise<void> {
    const dir = resolve(process.cwd(), dirArg ?? ".");
    const budget = Number.parseInt(options.maxTokens, 10);

    if (!Number.isFinite(budget) || budget <= 0) {
        logger.error(`Invalid --max-tokens: ${options.maxTokens}`);
        logger.info(suggestCommand("tools repo-map", { add: ["--max-tokens", "8000"] }));
        process.exitCode = 1;
        return;
    }

    const languages = parseLanguages(options.lang);
    const scan = await scanRepo({ dir, languages });

    if (scan.files.length === 0) {
        out.log.warn("No supported source files found.");
        out.result(options.json ? { root: scan.root, files: [], elided: [] } : "");
        return;
    }

    const ranked = rankFiles({
        files: scan.files.map((f) => ({
            path: f.path,
            size: f.size,
            fanIn: scan.fanIn[f.path] ?? 0,
            mtimeMs: f.mtimeMs,
        })),
        now: Date.now(),
    });

    const byPath = new Map<string, ScannedFileWithTokens>(scan.files.map((f) => [f.path, f]));
    const packInput = ranked.map((r) => ({ path: r.path, rank: r.rank, tokens: byPath.get(r.path)?.tokens ?? 0 }));
    const packed = packByBudget({ files: packInput, budget });

    const included: IncludedFile[] = packed.included
        .map((p) => byPath.get(p.path))
        .filter((f): f is ScannedFileWithTokens => Boolean(f))
        .map((file) => ({ file, tokens: file.tokens }));
    const elided = packed.elided.map((p) => byPath.get(p.path)).filter((f): f is ScannedFileWithTokens => Boolean(f));

    const summary = {
        root: scan.root,
        budget,
        usedTokens: packed.usedTokens,
        filesIncluded: included.length,
        filesTotal: scan.files.length,
    };

    if (options.json) {
        if (options.clipboard) {
            out.log.warn("--clipboard ignored with --json (structured output goes to stdout).");
        }

        out.result(renderJson({ ...summary, included, elided }));
        return;
    }

    const text = renderTree({ ...summary, included, elided, filesOnly: Boolean(options.filesOnly) });

    if (options.clipboard) {
        try {
            await clipboardy.write(text);
            out.log.success(`Copied repo map to clipboard (${included.length} files, ${packed.usedTokens} tok).`);
            return;
        } catch (err) {
            out.log.error(
                `Failed to copy to clipboard, printing to stdout instead: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    out.result(text);
}

const program = new Command()
    .name("repo-map")
    .description("Token-efficient repo symbol map for agents (aider-style)")
    .argument("[dir]", "Directory to map", ".")
    .option("--max-tokens <n>", "Token budget for the rendered map", "8000")
    .option(
        "--lang <list>",
        "Restrict to languages (comma-separated, repeatable)",
        (v, prev: string[]) => [...prev, v],
        []
    )
    .option("--json", "Emit structured JSON instead of a tree")
    .option("--files-only", "List ranked files without per-file symbols")
    .option("--clipboard", "Copy the rendered map to the clipboard")
    .action(async (dirArg: string | undefined, options: Options) => {
        await main(dirArg, options);
    });

await runTool(program, { tool: "repo-map" });
