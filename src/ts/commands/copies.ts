import { relative } from "node:path";
import type { Block } from "@genesiscz/utils/json2md";
import type { Command } from "commander";
import pc from "picocolors";
import { collectAll } from "../lib/collect";
import { emit, type FormatFlags, resolveFormat } from "../lib/format";
import { buildInventory, type SharedCopy, sharedCopies } from "../lib/inventory";
import { addFormatOptions, addScanOptions, numberArg, runUsage } from "./options";

interface CopiesCliOptions extends FormatFlags {
    shared?: string;
    tests?: boolean;
    ignore?: string[];
    limit?: number;
}

const HOW: Record<SharedCopy["how"], string> = {
    "same-name": "declared again under its name",
    renamed: "declared again under a copy's name",
    "same-body": "its body, under another name",
};

async function runCopies(paths: string[], options: CopiesCliOptions): Promise<void> {
    const format = resolveFormat(options);
    const shared = options.shared ?? "src/utils";
    const { files } = collectAll(paths.length > 0 ? paths : ["src"], {
        tests: options.tests === true,
        ignore: options.ignore,
    });
    const rel = (file: string) => relative(process.cwd(), file);
    const inventory = await buildInventory(files.map(rel));
    const copies = sharedCopies(inventory, shared);
    const byOwner = new Map<string, SharedCopy[]>();

    for (const copy of copies) {
        const key = `${copy.owner.name} (${copy.owner.file}:${copy.owner.line})`;
        byOwner.set(key, [...(byOwner.get(key) ?? []), copy]);
    }

    const groups = [...byOwner].sort((a, b) => b[1].length - a[1].length).slice(0, options.limit ?? 40);

    emit(format, {
        text: () => [
            ...groups.flatMap(([owner, list]) => [
                `${pc.bold(owner)}  ${list.length} cop${list.length === 1 ? "y" : "ies"}`,
                ...list.map((copy) => `  ${copy.file}:${copy.line}  ${copy.name}  ${pc.dim(HOW[copy.how])}`),
            ]),
            "",
            pc.dim(
                `${copies.length} copies of ${byOwner.size} helpers that ${shared} exports, in ${inventory.functions.length} functions of ${files.length} files`
            ),
        ],
        md: (): Block[] => [
            { h2: `Copies of ${shared} exports` },
            ...groups.flatMap(([owner, list]): Block[] => [
                { h3: owner },
                { ul: list.map((copy) => `\`${copy.file}:${copy.line}\` ${copy.name}: ${HOW[copy.how]}`) },
            ]),
        ],
        json: () => ({ shared, copies, scanned: { files: files.length, functions: inventory.functions.length } }),
    });
}

export function registerCopiesCommands(program: Command): void {
    const command = program
        .command("copies")
        .description(
            "Functions that copy a helper a shared folder exports: under its name, a copy's name (myX, xLocal, x2) or with its body under any name"
        )
        .argument("[paths...]", "Files or directories to look in (default src)")
        .option("--shared <folder>", "The folder whose exports are the originals (default src/utils)")
        .option("--limit <n>", "Show at most this many helpers (default 40)", numberArg({ min: 1, integer: true }));

    addScanOptions(command);
    addFormatOptions(command);

    command.action(async (paths: string[], options: CopiesCliOptions) => {
        await runUsage(command, () => runCopies(paths, options));
    });
}
