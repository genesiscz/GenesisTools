import { INPUT_FORMATS, type InputFormat, readInput } from "@app/json2md/lib/input";
import { parseColumns, parsePairs, resolveEnumFlag } from "@app/json2md/lib/options";
import { deliver } from "@app/json2md/lib/output";
import {
    type ConvertOptions,
    type FrontmatterFormat,
    type HeaderCase,
    type HeadingLevel,
    json2md,
    jsonToMarkdown,
    type OverflowStrategy,
} from "@genesiscz/utils/json2md";
import { stampMarkdown } from "@genesiscz/utils/json2md/integrity";
import { guessDialect, type SelectDialect, selectValue } from "@genesiscz/utils/json2md/select";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const HEADER_CASES: readonly HeaderCase[] = [
    "preserve",
    "camelCase",
    "capitalCase",
    "constantCase",
    "dotCase",
    "kebabCase",
    "noCase",
    "pascalCase",
    "pathCase",
    "sentenceCase",
    "snakeCase",
    "titleCase",
    "trainCase",
] as const;

const FRONTMATTER_FORMATS: readonly FrontmatterFormat[] = ["yaml", "json", "toml"] as const;
const DIALECTS: readonly SelectDialect[] = ["jmespath", "jsonpath"] as const;
const OVERFLOWS: readonly OverflowStrategy[] = ["wrap", "truncateStart", "truncateEnd"] as const;
const MODES = ["auto", "blocks"] as const;
const ENGINES = ["string", "mdast"] as const;

interface ConvertFlags {
    from?: string;
    mode?: string;
    engine?: string;
    select?: string;
    dialect?: string;
    title?: string;
    output?: string;
    clipboard?: boolean;
    repair?: boolean;
    toc?: boolean;
    stamp?: boolean;
    frontmatter?: string;
    meta?: string[];
    provenanceScope?: string;
    provenanceCommit?: string;
    headingLevel?: string;
    collapseDepth?: string;
    maxHeadingDepth?: string;
    keyCase?: string;
    columns?: string;
    maxWidth?: string;
    overflow?: string;
    arraySeparator?: string;
    emptyText?: string;
    bullet?: string;
    align?: boolean;
    mermaid?: boolean;
    titleKey?: string;
    ask?: boolean;
}

function intOrUndefined(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${flag} expects a non-negative whole number, got: ${value}`);
    }

    return parsed;
}

export function registerConvertCommand(program: Command): void {
    program
        .argument("[input]", 'JSON file, "-" for stdin, or pipe data in')
        .option("--from [format]", `input format: ${INPUT_FORMATS.join(" | ")}`)
        .option("--mode [mode]", `auto shape detection, or treat the input as a block document: ${MODES.join(" | ")}`)
        .option("--engine [engine]", `renderer backend: ${ENGINES.join(" | ")}`)
        .option("--repair", "run jsonrepair over invalid JSON before parsing")
        .option(
            "-s, --select <expr>",
            "select a sub-tree before rendering (JMESPath, or JSONPath when it starts with $)"
        )
        .option("--dialect [dialect]", `selection language: ${DIALECTS.join(" | ")}`)
        .option("-t, --title <text>", "an H1 above the document")
        .option("--frontmatter [format]", `emit front matter: ${FRONTMATTER_FORMATS.join(" | ")}`)
        .option("--meta <key=value...>", "front-matter entries, repeatable")
        .option("--toc", "insert a table of contents")
        .option("--provenance-scope <text>", "one sentence naming what the document covers")
        .option("--provenance-commit <sha>", "commit the data was read at")
        .option("--stamp", "append a json2md stamp so a later hand edit can be detected")
        .option("--heading-level <n>", "heading level for the outermost sections (default 2)")
        .option("--collapse-depth <n>", "wrap branches deeper than this in <details> (default 3, 0 disables)")
        .option("--max-heading-depth <n>", "deepest level that still gets a heading (default 4)")
        .option("--key-case [style]", `casing for keys used as headings and headers: ${HEADER_CASES.join(" | ")}`)
        .option("--title-key <key>", "key whose value titles each section of an array of objects")
        .option("--mermaid", "render tree-shaped arrays as a mermaid graph")
        .option("--columns <list>", "table columns: key, key:Header, or key:Header:right, comma separated")
        .option("--max-width <n>", "width budget per table column")
        .option("--overflow [strategy]", `what to do with an over-wide cell: ${OVERFLOWS.join(" | ")}`)
        .option("--array-separator <text>", 'join array cells with this (default ", ")')
        .option("--empty-text <text>", 'what an empty table renders as (default "_No rows._")')
        .option("--bullet <char>", "unordered list marker: - | * | +")
        .option("--no-align", "do not pad table cells to the column width")
        .option("-o, --output <file>", "write the markdown to a file")
        .option("-c, --clipboard", "copy the markdown to the clipboard")
        .option("--ask", "ask where to put the output when nothing was chosen")
        .action(async (input: string | undefined, flags: ConvertFlags) => {
            const from = await resolveEnumFlag({
                given: flags.from,
                flag: "--from",
                values: INPUT_FORMATS,
                fallback: "auto" as InputFormat,
                label: "Input format",
            });

            if (from === undefined) {
                process.exitCode = 1;

                return;
            }

            const mode = await resolveEnumFlag({
                given: flags.mode,
                flag: "--mode",
                values: MODES,
                fallback: "auto",
                label: "Render mode",
            });

            if (mode === undefined) {
                process.exitCode = 1;

                return;
            }

            const engine = await resolveEnumFlag({
                given: flags.engine,
                flag: "--engine",
                values: ENGINES,
                fallback: "string",
                label: "Renderer backend",
            });

            if (engine === undefined) {
                process.exitCode = 1;

                return;
            }

            if (engine === "mdast") {
                out.log.error("The mdast backend is not built in this release.");
                out.log.info(
                    "It needs mdast-util-to-markdown, mdast-util-gfm and mdast-util-from-markdown, which are not dependencies of this repo. The string engine renders every block type the mdast one would."
                );
                process.exitCode = 1;

                return;
            }

            const keyCase = await resolveEnumFlag({
                given: flags.keyCase,
                flag: "--key-case",
                values: HEADER_CASES,
                fallback: "preserve" as HeaderCase,
                label: "Key casing",
            });

            if (keyCase === undefined) {
                process.exitCode = 1;

                return;
            }

            const overflow = await resolveEnumFlag({
                given: flags.overflow,
                flag: "--overflow",
                values: OVERFLOWS,
                fallback: "truncateEnd" as OverflowStrategy,
                label: "Cell overflow",
            });

            if (overflow === undefined) {
                process.exitCode = 1;

                return;
            }

            const frontmatterFormat =
                flags.frontmatter === undefined
                    ? undefined
                    : await resolveEnumFlag({
                          given: flags.frontmatter,
                          flag: "--frontmatter",
                          values: FRONTMATTER_FORMATS,
                          fallback: "yaml" as FrontmatterFormat,
                          label: "Front-matter format",
                      });

            if (flags.frontmatter !== undefined && frontmatterFormat === undefined) {
                process.exitCode = 1;

                return;
            }

            // Validated like every other enum flag. A cast let `--dialect xpath` run as JMESPath
            // silently, and a bare `--dialect` (`true`) skipped the guess and failed as "true".
            const dialect =
                flags.dialect === undefined
                    ? undefined
                    : await resolveEnumFlag({
                          given: flags.dialect,
                          flag: "--dialect",
                          values: DIALECTS,
                          fallback: "jmespath" as SelectDialect,
                          label: "Selection language",
                      });

            if (flags.dialect !== undefined && dialect === undefined) {
                process.exitCode = 1;

                return;
            }

            const { value, source, detected } = await readInput({
                arg: input,
                isTTY: process.stdin.isTTY === true,
                format: from,
                repair: flags.repair,
            });

            const selected = flags.select
                ? selectValue(value, flags.select, {
                      dialect: dialect ?? guessDialect(flags.select),
                  })
                : value;

            const meta = parsePairs(flags.meta);
            const wantsFrontmatter = flags.frontmatter !== undefined || Object.keys(meta).length > 0;

            const options: ConvertOptions = {
                title: flags.title,
                toc: flags.toc,
                frontmatter: wantsFrontmatter ? meta : undefined,
                frontmatterFormat: frontmatterFormat ?? "yaml",
                provenance:
                    flags.provenanceScope || flags.provenanceCommit
                        ? { scope: flags.provenanceScope, commit: flags.provenanceCommit }
                        : undefined,
                headingLevel: intOrUndefined(flags.headingLevel, "--heading-level") as HeadingLevel | undefined,
                collapseDepth: intOrUndefined(flags.collapseDepth, "--collapse-depth"),
                maxHeadingDepth: intOrUndefined(flags.maxHeadingDepth, "--max-heading-depth"),
                keyCase,
                titleKey: flags.titleKey,
                mermaidForTrees: flags.mermaid,
                bullet: flags.bullet === "*" || flags.bullet === "+" ? flags.bullet : "-",
                table: {
                    columns: parseColumns(flags.columns),
                    maxWidth: intOrUndefined(flags.maxWidth, "--max-width"),
                    overflow,
                    arraySeparator: flags.arraySeparator,
                    emptyText: flags.emptyText,
                    headerCase: keyCase,
                    // Commander stores `--no-align` as `align: false`; `noAlign` is never set.
                    alignDelimiters: flags.align !== false,
                },
            };

            logger.debug({ source, detected, mode, select: flags.select }, "json2md: rendering");

            const rendered =
                mode === "blocks"
                    ? json2md(selected as Parameters<typeof json2md>[0], options)
                    : jsonToMarkdown(selected, options);

            const markdown = flags.stamp ? stampMarkdown(rendered, { command: `tools json2md ${source}` }) : rendered;

            await deliver({ markdown, file: flags.output, clipboard: flags.clipboard, ask: flags.ask });
        });
}
