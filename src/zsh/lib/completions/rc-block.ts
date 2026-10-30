import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { createTwoFilesPatch } from "diff";
import { type CompletionProvider, completionFunctionName, type HandWiring, type LineRange } from "./providers";

export const BLOCK_START = "# >>> genesis-tools zsh completions >>>";
export const BLOCK_END = "# <<< genesis-tools zsh completions <<<";

/** Stands in for the tool's own block while hand blocks are replaced, so the block keeps its place in the file. */
const BLOCK_SLOT = "\u0000genesis-tools-zsh-completions-slot\u0000";

/** One hand-made block found in the rc, for one CLI. */
export interface FoundHandBlock {
    provider: CompletionProvider;
    wiring: HandWiring;
    range: LineRange;
    lines: string[];
    /** The block already is the tool's replacement text (an earlier run replaced it). */
    adopted: boolean;
}

/** `"$HOME/…"` when the path is under the home folder, so the rc line stays readable and portable. */
export function shellPath(path: string, home: string): string {
    const trimmedHome = home.replace(/\/+$/, "");

    if (trimmedHome && (path === trimmedHome || path.startsWith(`${trimmedHome}/`))) {
        return `"$HOME${path.slice(trimmedHome.length)}"`;
    }

    return `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The tool's rc block for these CLIs. It reads static files only: no CLI runs when a shell starts. It goes after
 * every compinit of the rc (the block is appended), so it registers each CLI with `compdef` itself instead of
 * relying on a compinit dump, which `compinit -C` never refreshes.
 */
export function renderBlock(input: {
    providers: readonly CompletionProvider[];
    completionsDir: string;
    home: string;
}): string {
    const dir = shellPath(input.completionsDir, input.home);
    const fpathOnes = input.providers.filter((provider) => provider.wiring === "fpath");
    const sourceOnes = input.providers.filter((provider) => provider.wiring === "source");
    const lines = [
        BLOCK_START,
        `# Static files written once by \`${toolCommand("zsh completions")}\`; no CLI runs at shell start.`,
        `# After a CLI update: ${toolCommand("zsh completions refresh")}. Remove: ${toolCommand("zsh completions uninstall")}.`,
        `__gt_completions=${dir}`,
        "fpath=($__gt_completions $fpath)",
        "(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -C; }",
    ];

    for (const provider of fpathOnes) {
        const fn = completionFunctionName(provider.cli);
        lines.push(`[[ -r $__gt_completions/${fn} ]] && autoload -Uz ${fn} && compdef ${fn} ${provider.cli}`);
    }

    for (const provider of sourceOnes) {
        const fn = completionFunctionName(provider.cli);
        lines.push(`[[ -r $__gt_completions/${fn} ]] && source $__gt_completions/${fn}`);
    }

    lines.push("unset __gt_completions", BLOCK_END);
    return lines.join("\n");
}

function splitLines(text: string): string[] {
    return text === "" ? [] : text.split("\n");
}

/** The range of the tool's own block, or undefined. A start marker without an end marker is refused. */
export function findOwnBlock(lines: readonly string[]): LineRange | undefined {
    const start = lines.findIndex((line) => line.trim() === BLOCK_START);

    if (start === -1) {
        return undefined;
    }

    const end = lines.findIndex((line, index) => index > start && line.trim() === BLOCK_END);

    if (end === -1) {
        throw new Error(`The rc file has "${BLOCK_START}" but no "${BLOCK_END}" line. Fix it by hand and run again.`);
    }

    return { start, end };
}

/** The rc text without the tool's block (and without the one blank line the install put before it). */
export function stripOwnBlock(text: string): string {
    const lines = splitLines(text);
    const range = findOwnBlock(lines);

    if (!range) {
        return text;
    }

    const from = range.start > 0 && (lines[range.start - 1] ?? "").trim() === "" ? range.start - 1 : range.start;
    lines.splice(from, range.end - from + 1);
    return lines.join("\n");
}

function overlaps(a: LineRange, b: LineRange): boolean {
    return a.start <= b.end && b.start <= a.end;
}

function sameLines(a: readonly string[], b: readonly string[] | undefined): boolean {
    return (
        b !== undefined && a.length === b.length && a.every((line, index) => line.trim() === (b[index] ?? "").trim())
    );
}

/** Every hand-made block of these CLIs, outside the tool's own block. */
export function findHandBlocks(text: string, providers: readonly CompletionProvider[]): FoundHandBlock[] {
    const lines = splitLines(text);
    const own = findOwnBlock(lines);
    const found: FoundHandBlock[] = [];

    for (const provider of providers) {
        for (const wiring of provider.handWiring) {
            const range = wiring.find(lines);

            if (!range || (own && overlaps(range, own))) {
                continue;
            }

            if (found.some((block) => overlaps(block.range, range))) {
                continue;
            }

            const blockLines = lines.slice(range.start, range.end + 1);
            found.push({
                provider,
                wiring,
                range,
                lines: blockLines,
                adopted: sameLines(blockLines, wiring.replacement),
            });
        }
    }

    return found.sort((a, b) => a.range.start - b.range.start);
}

/** A hand block the user may be asked about: it has a replacement and is not replaced yet. */
export function isReplaceable(block: FoundHandBlock): boolean {
    return block.wiring.replacement !== undefined && !block.adopted;
}

export interface CompletionPlanInput {
    /** The rc text now ("" when the file does not exist). */
    rcText: string;
    /** The CLIs to wire (found on PATH and selected). */
    selected: readonly CompletionProvider[];
    /** The hand blocks the user agreed to replace. Only replaceable blocks of selected CLIs are honoured. */
    replace: readonly FoundHandBlock[];
    completionsDir: string;
    home: string;
}

export interface SkippedCompletion {
    provider: CompletionProvider;
    block: FoundHandBlock;
}

export interface CompletionPlan {
    before: string;
    after: string;
    /** The CLIs the tool's block wires. */
    wired: CompletionProvider[];
    /** Selected CLIs left to their kept hand wiring, so the tool does not wire them twice. */
    skipped: SkippedCompletion[];
    replaced: FoundHandBlock[];
    /** Hand blocks of selected CLIs that stay as they are. */
    kept: FoundHandBlock[];
}

function sameBlock(a: FoundHandBlock, b: FoundHandBlock): boolean {
    return a.provider.cli === b.provider.cli && a.range.start === b.range.start && a.range.end === b.range.end;
}

/**
 * The rc text after the install: the agreed hand blocks replaced, the tool's block rewritten in place (or appended
 * at the end of the file, after every compinit), and nothing else changed. Pure: it reads and writes no file.
 */
export function planCompletions(input: CompletionPlanInput): CompletionPlan {
    const lines = splitLines(input.rcText);
    const own = findOwnBlock(lines);
    const hand = findHandBlocks(input.rcText, input.selected);
    const replaced = hand.filter((block) => isReplaceable(block) && input.replace.some((r) => sameBlock(r, block)));
    const kept = hand.filter((block) => !replaced.includes(block));
    const skipped: SkippedCompletion[] = [];

    for (const block of kept) {
        if (block.adopted || block.wiring.coexists) {
            continue;
        }

        if (!skipped.some((entry) => entry.provider.cli === block.provider.cli)) {
            skipped.push({ provider: block.provider, block });
        }
    }

    const wired = input.selected.filter((provider) => !skipped.some((entry) => entry.provider.cli === provider.cli));

    const edits: Array<{ range: LineRange; lines: readonly string[] }> = replaced.map((block) => ({
        range: block.range,
        lines: block.wiring.replacement ?? [],
    }));

    if (own) {
        edits.push({ range: own, lines: [BLOCK_SLOT] });
    }

    for (const edit of [...edits].sort((a, b) => b.range.start - a.range.start)) {
        lines.splice(edit.range.start, edit.range.end - edit.range.start + 1, ...edit.lines);
    }

    const block =
        wired.length > 0
            ? renderBlock({ providers: wired, completionsDir: input.completionsDir, home: input.home })
            : "";
    let after: string;
    const slotIndex = lines.indexOf(BLOCK_SLOT);

    if (slotIndex !== -1) {
        if (block) {
            lines.splice(slotIndex, 1, block);
        } else {
            const from = slotIndex > 0 && (lines[slotIndex - 1] ?? "").trim() === "" ? slotIndex - 1 : slotIndex;
            lines.splice(from, slotIndex - from + 1);
        }

        after = lines.join("\n");
    } else if (block) {
        const body = lines.join("\n").replace(/\n*$/, "");
        after = `${body}${body ? "\n\n" : ""}${block}\n`;
    } else {
        after = lines.join("\n");
    }

    return { before: input.rcText, after, wired, skipped, replaced, kept };
}

/** A hand block the tool replaced: what stood there, and the lines that stand there now. */
export interface ReplacedHandBlock {
    original: string[];
    replacement: string[];
}

/** The record to keep for a replaced block, so `uninstall` (or deselecting the CLI) can put the original back. */
export function replacedRecord(block: FoundHandBlock): ReplacedHandBlock {
    return { original: [...block.lines], replacement: [...(block.wiring.replacement ?? [])] };
}

function findSequence(lines: readonly string[], sequence: readonly string[]): number {
    if (sequence.length === 0) {
        return -1;
    }

    for (let i = 0; i + sequence.length <= lines.length; i++) {
        if (sequence.every((line, offset) => (lines[i + offset] ?? "").trim() === line.trim())) {
            return i;
        }
    }

    return -1;
}

/**
 * Puts replaced hand blocks back: each record's replacement lines become its original lines again. A record whose
 * replacement is no longer in the text (someone edited it) is returned in `missing` and changes nothing.
 */
export function restoreHandBlocks(
    text: string,
    records: readonly ReplacedHandBlock[]
): { text: string; restored: ReplacedHandBlock[]; missing: ReplacedHandBlock[] } {
    const lines = splitLines(text);
    const restored: ReplacedHandBlock[] = [];
    const missing: ReplacedHandBlock[] = [];

    for (const record of records) {
        const at = findSequence(lines, record.replacement);

        if (at === -1) {
            missing.push(record);
            continue;
        }

        lines.splice(at, record.replacement.length, ...record.original);
        restored.push(record);
    }

    return { text: restored.length > 0 ? lines.join("\n") : text, restored, missing };
}

/** A unified diff of the planned rc change, empty when nothing changes. */
export function rcDiff(input: { rcPath: string; before: string; after: string }): string {
    if (input.before === input.after) {
        return "";
    }

    return createTwoFilesPatch(input.rcPath, input.rcPath, input.before, input.after, "now", "planned", { context: 2 });
}

/** The generated file of one CLI. */
export function completionFilePath(completionsDir: string, cli: string): string {
    return join(completionsDir, completionFunctionName(cli));
}
