import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import type { Block } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { type DuplicateGroup, type DuplicateReport, findDuplicates } from "../lib/duplicates";
import { emit, resolveFormat } from "../lib/format";
import { loadFiles } from "../lib/load";
import { DECLARATION_KINDS } from "../lib/skeleton";
import {
    addFormatOptions,
    addScanOptions,
    type FormatCliFlags,
    numberArg,
    runUsage,
    type ScanCliFlags,
} from "./options";

interface DuplicatesCliOptions extends FormatCliFlags, ScanCliFlags {
    minLines?: number;
    similarity?: number;
    kinds?: string;
    locals?: boolean;
    recommend?: boolean;
    includePatterns?: boolean;
    includeSameFile?: boolean;
    includeNameCollisions?: boolean;
    limit?: number;
}

function headline(group: DuplicateGroup): string {
    const names =
        group.names.length === 1 ? `\`${group.names[0]}\`` : group.names.map((name) => `\`${name}\``).join(" / ");
    const alike = group.reason === "identical" ? "identical" : `${Math.round(group.similarity * 100)}% alike`;

    return `${names} · ${group.copies} copies · ${group.lines} lines · ${alike}`;
}

function renderText(report: DuplicateReport, limit: number): string[] {
    const lines: string[] = [];

    lines.push("");
    lines.push(
        `${pc.bold("duplicates")} ${pc.green(`${report.groups.length} group(s)`)} ${pc.dim(
            `from ${report.scanned.candidates} declarations in ${report.scanned.files} files`
        )}`
    );

    if (report.groups.length === 0) {
        lines.push(pc.dim("  nothing above the thresholds"));
    }

    for (const group of report.groups.slice(0, limit)) {
        lines.push("");
        lines.push(`${pc.yellow("▪")} ${pc.bold(headline(group))} ${pc.dim(`· ${group.wastedLines} lines would go`)}`);

        if (group.pattern) {
            lines.push(pc.dim(`  pattern: ${group.patternReason}`));
        }

        for (const member of group.members) {
            const mark = member === group.canonical ? pc.green(" ← keep this one") : "";
            const local = member.local ? pc.dim(" ·local") : "";
            const named = group.names.length > 1 ? ` ${pc.yellow(member.name)}` : "";

            lines.push(`    ${pc.cyan(`${member.file}:${member.startLine}-${member.endLine}`)}${named}${local}${mark}`);
        }

        if (group.action) {
            lines.push(`    ${pc.dim("→")} ${group.action}`);
        }
    }

    for (const collision of report.collisions.slice(0, limit)) {
        lines.push("");
        lines.push(
            `${pc.magenta("▫")} ${pc.bold(`\`${collision.name}\``)} ${pc.dim(
                `· ${collision.members.length} unrelated definitions share this name`
            )}`
        );

        for (const member of collision.members) {
            lines.push(`    ${pc.cyan(`${member.file}:${member.startLine}`)} ${pc.dim(member.signature)}`);
        }
    }

    lines.push("");
    lines.push(
        pc.dim(
            `suppressed: ${report.suppressed.patterns} deliberate pattern(s), ` +
                `${report.suppressed.sameFile} single-file group(s), ` +
                `${report.suppressed.tooSmall} declaration(s) under the line floor` +
                (report.suppressed.oversizedBuckets > 0
                    ? `, ${report.suppressed.oversizedBuckets} oversized bucket(s) skipped`
                    : "")
        )
    );

    return lines;
}

function renderMarkdown(report: DuplicateReport, limit: number): Block[] {
    const blocks: Block[] = [
        { h1: "Duplicate declarations" },
        `${report.groups.length} groups from ${report.scanned.candidates} declarations in ${report.scanned.files} files.`,
    ];

    if (report.groups.length > 0) {
        blocks.push({
            table: {
                rows: report.groups.slice(0, limit).map((group) => ({
                    Name: group.names.join(" / "),
                    Copies: group.copies,
                    Lines: group.lines,
                    Alike: group.reason === "identical" ? "identical" : `${Math.round(group.similarity * 100)}%`,
                    Wasted: group.wastedLines,
                    Keep: group.canonical ? `${group.canonical.file}:${group.canonical.startLine}` : "",
                })),
            },
        });

        for (const group of report.groups.slice(0, limit)) {
            blocks.push({ h2: headline(group) });

            if (group.pattern) {
                blocks.push({
                    callout: { kind: "note", title: "Looks deliberate", body: group.patternReason ?? "" },
                });
            }

            blocks.push({
                ul: group.members.map(
                    (member) =>
                        `\`${member.file}:${member.startLine}-${member.endLine}\` ${member.name}` +
                        (member === group.canonical ? " — **keep this one**" : "")
                ),
            });

            if (group.action) {
                blocks.push(`**Do:** ${group.action}`);
            }
        }
    }

    if (report.collisions.length > 0) {
        blocks.push({ h2: "Name collisions" });
        blocks.push("Same name, unrelated code. Not duplication, but a reader has to disambiguate every time.");
        blocks.push({
            table: {
                rows: report.collisions.slice(0, limit).map((collision) => ({
                    Name: collision.name,
                    Kind: collision.kind,
                    Definitions: collision.members.length,
                    Where: collision.members.map((member) => `${member.file}:${member.startLine}`).join(", "),
                })),
            },
        });
    }

    blocks.push({ h2: "Suppressed" });
    blocks.push({
        ul: [
            `${report.suppressed.patterns} deliberate pattern groups (use \`--include-patterns\` to see them)`,
            `${report.suppressed.sameFile} groups whose copies share one file (\`--include-same-file\`)`,
            `${report.suppressed.tooSmall} declarations under the line floor (\`--min-lines\`)`,
        ],
    });

    return blocks;
}

async function runDuplicates(paths: string[], options: DuplicatesCliOptions): Promise<void> {
    const format = resolveFormat(options);
    const limit = options.limit ?? 40;
    const kinds = options.kinds?.split(",").map((kind) => kind.trim());
    const known: readonly string[] = DECLARATION_KINDS;
    const unknown = kinds?.filter((kind) => !known.includes(kind)) ?? [];

    // An unknown kind (`functions` for `function`) matched nothing, and the run reported
    // "no duplicates" with a success exit.
    if (unknown.length > 0) {
        ui.err(
            suggestEnumFlag("tools ts", "--kinds", DECLARATION_KINDS, {
                given: unknown.join(","),
            })
        );
        process.exitCode = 1;
        return;
    }

    const loaded = await loadFiles(paths, {
        tests: options.tests === true,
        ignore: options.ignore,
        locals: options.locals === true,
        hash: true,
    });

    for (const input of loaded.empty) {
        logger.error({ input }, "No TypeScript source found");
        process.exitCode = 1;
    }

    const report = findDuplicates(loaded.entries, {
        minLines: options.minLines ?? 3,
        similarity: options.similarity ?? 0.8,
        kinds,
        includePatterns: options.includePatterns === true,
        includeSameFile: options.includeSameFile === true,
        nameCollisions: options.includeNameCollisions === true,
        recommend: options.recommend === true,
    });

    emit(format, {
        text: () => renderText(report, limit),
        md: () => renderMarkdown(report, limit),
        json: () => ({
            groups: report.groups.slice(0, limit),
            collisions: report.collisions.slice(0, limit),
            scanned: report.scanned,
            suppressed: report.suppressed,
        }),
        compact: () => ({
            cols: ["file", "startLine", "endLine", "name", "kind", "lines", "exported", "canonical"],
            groups: report.groups.slice(0, limit).map((group) => ({
                names: group.names,
                reason: group.reason,
                similarity: group.similarity,
                copies: group.copies,
                wastedLines: group.wastedLines,
                score: group.score,
                pattern: group.pattern,
                action: group.action,
                members: group.members.map((member) => [
                    member.file,
                    member.startLine,
                    member.endLine,
                    member.name,
                    member.kind,
                    member.lines,
                    member.exported,
                    member === group.canonical,
                ]),
            })),
            collisions: report.collisions.slice(0, limit),
            scanned: report.scanned,
            suppressed: report.suppressed,
        }),
    });

    ui.raw("");
    ui.raw(
        `${pc.cyan("●")} ${report.groups.length} group(s) · ` +
            `${report.groups.reduce((total, group) => total + group.wastedLines, 0)} lines could go · ` +
            `${report.scanned.candidates} declarations compared`
    );
}

export function registerDuplicatesCommands(program: Command): void {
    const command = program
        .command("duplicates")
        .alias("dupes")
        .description("The same code written more than once, whether or not the copies share a name")
        .argument("<paths...>", "Files or directories; a directory is walked recursively")
        .option(
            "--min-lines <n>",
            "Ignore declarations shorter than this (default 3)",
            numberArg({ min: 1, integer: true })
        )
        .option(
            "--similarity <ratio>",
            "How alike two bodies must be, 0 to 1 (default 0.8)",
            numberArg({ min: 0, max: 1 })
        )
        .option("--kinds <list>", "Comma-separated declaration kinds to compare")
        .option("--locals", "Also compare declarations inside function bodies")
        .option("--recommend", "Pick the copy to keep and write the edit that removes the others")
        .option("--include-patterns", "Show the groups that look like a deliberate repeated shape")
        .option("--include-same-file", "Show groups whose copies all live in one file")
        .option("--include-name-collisions", "Also list same-name declarations whose code differs")
        .option("--limit <n>", "Show at most this many groups (default 40)", numberArg({ min: 1, integer: true }));

    addScanOptions(command);
    addFormatOptions(command);

    command.action(async (paths: string[], options: DuplicatesCliOptions) => {
        await runUsage(command, () => runDuplicates(paths, options));
    });
}
