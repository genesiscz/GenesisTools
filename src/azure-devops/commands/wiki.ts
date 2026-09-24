import { resolve } from "node:path";
import { Api } from "@app/azure-devops/api";
import {
    diffWikiPage,
    fillPageIds,
    flattenPageTree,
    loadWikiPageDetails,
    pickWiki,
    recursionLevelForDepth,
    renderWikiPageMarkdown,
    resolveWikiPage,
    stripHighlightTags,
    toPageChange,
    toSearchRows,
} from "@app/azure-devops/lib/wiki";
import { requireConfig } from "@app/azure-devops/utils";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const TABLE_FORMATS = ["table", "json"] as const;
const PAGE_FORMATS = ["md", "json"] as const;
const DIFF_FORMATS = ["diff", "json"] as const;
const TOOL = "tools azure-devops";
const AUTO_ID_LIMIT = 50;

function checkFormat(format: string, values: readonly string[], subcommand: string[]): boolean {
    if (values.includes(format)) {
        return true;
    }

    out.error(suggestEnumFlag(`${TOOL} ${subcommand.join(" ")}`, "--format", values, { subcommand, given: format }));
    process.exitCode = 1;
    return false;
}

function parseCount(value: string, flag: string, { allowZero = false } = {}): number | null {
    const count = Number(value);

    if (!Number.isInteger(count) || count < (allowZero ? 0 : 1)) {
        out.error(`Invalid ${flag} '${value}': expected a ${allowZero ? "non-negative" : "positive"} whole number`);
        process.exitCode = 1;
        return null;
    }

    return count;
}

export function registerWikiCommand(program: Command): void {
    const wiki = program
        .command("wiki")
        .description("Project wikis: list wikis, list pages, read a page, search, page history");

    wiki.command("list")
        .alias("ls")
        .description("List the project's wikis")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (options: { format: string }) => {
            if (!checkFormat(options.format, TABLE_FORMATS, ["wiki", "list"])) {
                return;
            }

            const api = new Api(requireConfig());
            const wikis = await api.getWikis();

            if (options.format === "json") {
                out.result(wikis);
                return;
            }

            renderCliHeader("Wikis", `${wikis.length} in the project`);
            const table = createBoxTable(["NAME", "TYPE", "BRANCH", "MAPPED PATH", "ID"]);

            for (const item of wikis) {
                table.push([
                    pc.white(item.name),
                    item.type,
                    item.versions?.[0]?.version ?? "—",
                    item.mappedPath,
                    pc.dim(item.id),
                ]);
            }

            out.println(table.toString());
            out.println(pc.dim(`\nNext: ${TOOL} wiki pages --wiki "<name>"`));
        });

    wiki.command("pages")
        .description("List the page tree under a path (default: the wiki root)")
        .argument("[path]", "Page path, page id or wiki page URL", "/")
        .option("--wiki <name>", "Wiki name or id (default: the project wiki)")
        .option("--depth <depth>", "Levels below the page: a number or 'all'", "1")
        .option("--ids", `Look up every page id (one call per page; automatic up to ${AUTO_ID_LIMIT} pages)`)
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (pathArg: string, options: { wiki?: string; depth: string; ids?: boolean; format: string }) => {
            if (!checkFormat(options.format, TABLE_FORMATS, ["wiki", "pages"])) {
                return;
            }

            let depth: number | "all" = "all";

            if (options.depth !== "all") {
                const parsed = parseCount(options.depth, "--depth", { allowZero: true });

                if (parsed === null) {
                    return;
                }

                depth = parsed;
            }

            const api = new Api(requireConfig());
            const { wiki: picked, page } = await resolveWikiPage({
                api,
                input: pathArg,
                wikiName: options.wiki,
                recursionLevel: recursionLevelForDepth(depth),
            });
            const tree = flattenPageTree(page, depth);
            const lookUpIds = options.ids === true || tree.length <= AUTO_ID_LIMIT;
            const rows = lookUpIds ? await fillPageIds({ api, wiki: picked, rows: tree }) : tree;

            if (options.format === "json") {
                out.result({ wiki: picked.name, root: page.path, rows });
                return;
            }

            renderCliHeader(`${picked.name}`, page.path);

            for (const row of rows) {
                const id = pc.dim(String(row.id ?? "").padStart(6));
                const marker = row.hasChildren ? pc.cyan("▸ ") : "  ";
                out.println(`${id}  ${"  ".repeat(row.depth)}${marker}${row.name}`);
            }

            out.println(pc.dim(`\n  ${rows.length} page(s) · read one: ${TOOL} wiki get <id|path>`));

            if (!lookUpIds) {
                out.println(pc.dim(`  Ids not looked up for ${rows.length} pages; add --ids to fetch them.`));
            }
        });

    wiki.command("get")
        .alias("show")
        .description("Show one page: details (id, path, URL, last change, views, subpages, attachments) and content")
        .argument("<page>", "Wiki page URL, page id or page path")
        .option("--wiki <name>", "Wiki name or id (default: the wiki in the URL, else the project wiki)")
        .option("-f, --format <format>", "Output format: md|json", "md")
        .option("--no-content", "Details only, without the page markdown")
        .option("--images", "Download the page's /.attachments/ files and point the links at the copies")
        .option("--output-dir <path>", "Where --images saves (default: .claude/azure/wiki/<wiki>/<pageId>/)")
        .option("-o, --output <file>", "Write the result to this file instead of stdout")
        .option("--views <days>", "Page views over the last N days (0 = skip the call)", "30")
        .action(
            async (
                pageArg: string,
                options: {
                    wiki?: string;
                    format: string;
                    content: boolean;
                    images?: boolean;
                    outputDir?: string;
                    output?: string;
                    views: string;
                }
            ) => {
                if (!checkFormat(options.format, PAGE_FORMATS, ["wiki", "get"])) {
                    return;
                }

                const viewsDays = parseCount(options.views, "--views", { allowZero: true });

                if (viewsDays === null) {
                    return;
                }

                const config = requireConfig();
                const api = new Api(config);
                const details = await loadWikiPageDetails({
                    api,
                    config,
                    input: pageArg,
                    wikiName: options.wiki,
                    includeContent: options.content,
                    viewsDays,
                    images: options.images ? { outputDir: options.outputDir } : undefined,
                });
                const rendered =
                    options.format === "json"
                        ? `${SafeJSON.stringify(details, null, 2)}\n`
                        : renderWikiPageMarkdown(details);

                if (options.output) {
                    const target = resolve(options.output);
                    await Bun.write(target, rendered);
                    out.println(`Saved ${details.title} to ${target}`);
                    return;
                }

                if (options.format === "json") {
                    out.result(details);
                    return;
                }

                out.print(rendered);
            }
        );

    wiki.command("search")
        .description("Full-text search over the wiki pages of the project")
        .argument("<text...>", "Search text")
        .option("--wiki <name>", "Only this wiki (name or id)")
        .option("--top <n>", "Maximum results", "25")
        .option("--skip <n>", "Skip the first N results", "0")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (textParts: string[], options: { wiki?: string; top: string; skip: string; format: string }) => {
            if (!checkFormat(options.format, TABLE_FORMATS, ["wiki", "search"])) {
                return;
            }

            const top = parseCount(options.top, "--top");
            const skip = parseCount(options.skip, "--skip", { allowZero: true });

            if (top === null || skip === null) {
                return;
            }

            const config = requireConfig();
            const api = new Api(config);
            const searchText = textParts.join(" ");
            let wikiNames: string[] | undefined;

            if (options.wiki) {
                wikiNames = [pickWiki(await api.getWikis(), options.wiki).name];
            }

            const response = await api.searchWiki({ searchText, wikiNames, top, skip });
            const rows = toSearchRows(config, response);

            if (options.format === "json") {
                out.result({ searchText, count: response.count, results: rows });
                return;
            }

            renderCliHeader(`Wiki search: ${searchText}`, `${response.count} match(es), showing ${rows.length}`);

            if (rows.length === 0) {
                out.println(pc.dim("  No page matches."));
                return;
            }

            const table = createBoxTable(["PAGE", "MATCH"]);

            for (const row of rows) {
                const match = stripHighlightTags(row.highlights[0] ?? "");
                table.push([truncateDisplay(row.pagePath, 70), truncateDisplay(match, 60)]);
            }

            out.println(table.toString());
            out.println(pc.dim(`\n  Read one: ${TOOL} wiki get "${rows[0].pagePath}"`));
        });

    wiki.command("diff")
        .description("What changed in a page between two versions (default: the last edit)")
        .argument("<page>", "Wiki page URL, page id or page path")
        .argument("[from]", "Older commit id or prefix (default: the version before <to>)")
        .argument("[to]", "Newer commit id or prefix (default: the newest version)")
        .option("--wiki <name>", "Wiki name or id (default: the wiki in the URL, else the project wiki)")
        .option("--context <n>", "Unchanged lines around each change", "3")
        .option("--format <format>", "Output format: diff|json", "diff")
        .action(
            async (
                pageArg: string,
                from: string | undefined,
                to: string | undefined,
                options: { wiki?: string; context: string; format: string }
            ) => {
                if (!checkFormat(options.format, DIFF_FORMATS, ["wiki", "diff"])) {
                    return;
                }

                const context = parseCount(options.context, "--context", { allowZero: true });

                if (context === null) {
                    return;
                }

                const config = requireConfig();
                const result = await diffWikiPage({
                    api: new Api(config),
                    config,
                    input: pageArg,
                    wikiName: options.wiki,
                    from,
                    to,
                    context,
                });

                if (options.format === "json") {
                    out.result(result);
                    return;
                }

                const describe = (change: typeof result.from): string =>
                    `${change.commitId.slice(0, 8)} ${change.date?.replace("T", " ").slice(0, 16) ?? "?"} ${change.author ?? "?"}`;
                renderCliHeader(`Diff: ${result.path}`, `${describe(result.from)} → ${describe(result.to)}`);

                if (!result.diff) {
                    out.println(pc.dim("  The two versions hold the same text."));
                    return;
                }

                for (const line of result.diff.split("\n")) {
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                        out.println(pc.green(line));
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                        out.println(pc.red(line));
                    } else if (line.startsWith("@@")) {
                        out.println(pc.cyan(line));
                    } else {
                        out.println(line);
                    }
                }
            }
        );

    wiki.command("history")
        .description("The commits that changed one page, newest first")
        .argument("<page>", "Wiki page URL, page id or page path")
        .option("--wiki <name>", "Wiki name or id (default: the wiki in the URL, else the project wiki)")
        .option("--top <n>", "Maximum commits", "20")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (pageArg: string, options: { wiki?: string; top: string; format: string }) => {
            if (!checkFormat(options.format, TABLE_FORMATS, ["wiki", "history"])) {
                return;
            }

            const top = parseCount(options.top, "--top");

            if (top === null) {
                return;
            }

            const api = new Api(requireConfig());
            const { wiki: picked, page } = await resolveWikiPage({
                api,
                input: pageArg,
                wikiName: options.wiki,
                recursionLevel: "none",
            });

            if (!page.gitItemPath) {
                out.error(`Page ${page.path} has no git path, so it has no history to read`);
                process.exitCode = 1;
                return;
            }

            const commits = await api.getGitCommitsForPath({
                repositoryId: picked.repositoryId,
                itemPath: page.gitItemPath,
                version: picked.versions?.[0]?.version,
                top,
            });
            const changes = commits.map(toPageChange);

            if (options.format === "json") {
                out.result({ wiki: picked.name, path: page.path, id: page.id, changes });
                return;
            }

            renderCliHeader(`History: ${page.path}`, `${changes.length} commit(s)`);
            const table = createBoxTable(["DATE", "AUTHOR", "COMMIT", "MESSAGE"]);

            for (const change of changes) {
                table.push([
                    change.date?.replace("T", " ").slice(0, 16) ?? "—",
                    truncateDisplay(change.author, 24),
                    pc.dim(change.commitId.slice(0, 8)),
                    truncateDisplay(change.message, 60),
                ]);
            }

            out.println(table.toString());
        });
}
