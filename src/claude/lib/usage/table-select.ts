import { isCancel, SelectPrompt } from "@clack/core";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import pc from "picocolors";
import type { ScoredAccount } from "./account-picker";
import {
    detailBlock,
    padVisible,
    TIER_BADGE,
    tableHeaderRow,
    tableRow,
    tableWidths,
    visibleWidth,
} from "./usage-table";

const S_ACTIVE = pc.cyan("◆");
const S_SUBMIT = pc.green("◇");
const S_CANCEL = pc.red("■");
const BAR = pc.gray("│");
const BAR_END = pc.gray("└");

interface TableSelectOptions {
    message: string;
    scored: ScoredAccount[];
    accountsByName: Map<string, AIAccountEntry>;
}

/** Pre-rendered static parts of the frame; only cursor/state vary per redraw. */
export function buildFrameParts(opts: TableSelectOptions, now: Date = new Date()) {
    const { scored, accountsByName } = opts;
    const widths = tableWidths(scored);
    const rows = scored.map((acc) => tableRow(acc, widths, now));
    const rowsFocused = scored.map((acc) => tableRow(acc, widths, now, true));
    const details = scored.map((acc) => detailBlock(acc, accountsByName.get(acc.accountName), now));
    const detailWidth = Math.max(...details.flat().map(visibleWidth));
    return { widths, rows, rowsFocused, details, detailWidth };
}

/**
 * Pure frame renderer: question, FIXED-HEIGHT detail zone that follows the
 * focused row, header row, then aligned table rows (which never wrap or
 * move). Extracted from the prompt for testability.
 */
export function renderFrame(
    opts: TableSelectOptions,
    parts: ReturnType<typeof buildFrameParts>,
    state: string,
    cursor: number
): string {
    const { scored } = opts;
    const { widths, rows, rowsFocused, details, detailWidth } = parts;
    const title = `${pc.gray("│")}\n${S_ACTIVE}  ${opts.message} ${pc.dim("(best first, % left)")}`;

    if (state === "submit") {
        return `${title.replace(S_ACTIVE, S_SUBMIT)}\n${BAR}  ${pc.dim(scored[cursor].accountName)}`;
    }

    if (state === "cancel") {
        return `${title.replace(S_ACTIVE, S_CANCEL)}\n${BAR}  ${pc.strikethrough(pc.dim("cancelled"))}`;
    }

    const detail = details[cursor];
    const lines: string[] = [title];

    // Fixed-height detail zone (padded so redraws never shrink or shift)
    for (const [i, line] of detail.entries()) {
        const gutter = i === 0 ? "┌" : i === detail.length - 1 ? "└" : "│";
        lines.push(`${BAR}  ${pc.gray(gutter)} ${padVisible(line, detailWidth)}`);
    }

    lines.push(BAR);
    lines.push(`${BAR}      ${tableHeaderRow(widths)}`);

    for (const [i, acc] of scored.entries()) {
        const focused = i === cursor;
        const pointer = focused ? pc.cyan("❯") : " ";
        lines.push(`${BAR}  ${pointer} ${TIER_BADGE[acc.tier]} ${focused ? rowsFocused[i] : rows[i]}`);
    }

    lines.push(BAR_END);
    return lines.join("\n");
}

/**
 * Custom @clack/core select that renders a real table (header row, aligned
 * columns) plus a fixed-height detail zone above it. Returns the picked
 * account name, or null on cancel.
 */
export async function tableSelectAccount(opts: TableSelectOptions): Promise<string | null> {
    const parts = buildFrameParts(opts);

    const prompt = new SelectPrompt({
        options: opts.scored.map((acc) => ({ value: acc.accountName })),
        initialValue: opts.scored[0].accountName,
        render() {
            return renderFrame(opts, parts, this.state, this.cursor);
        },
    });

    const result = await prompt.prompt();

    if (isCancel(result)) {
        return null;
    }

    return result as string;
}
