/**
 * Terminal rendering primitives: tables, bars, sparklines, heatmaps.
 *
 * These are dense analytics visuals (bar columns, sparkline columns, a 7x24 heat grid),
 * not the port-style inventory tables in `@genesiscz/utils/table` — `spotify profile list`
 * and `spotify doctor` use those instead. Colour comes from picocolors, which switches
 * itself off for NO_COLOR and for a non-TTY stdout, so piping any command into a file or
 * into `jq` never yields escape codes.
 */
import { pct } from "@app/spotify/lib/format";
import { out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";

// Number formatting is shared with the dashboard so the two never disagree on a rounding.
export { compact, hours, int, pct } from "@app/spotify/lib/format";

type Colorize = (s: string | number) => string;

const wrap =
    (fn: (s: string) => string): Colorize =>
    (s) =>
        fn(String(s));

export const c = {
    bold: wrap(pc.bold),
    dim: wrap(pc.dim),
    red: wrap(pc.red),
    green: wrap(pc.green),
    yellow: wrap(pc.yellow),
    blue: wrap(pc.blue),
    magenta: wrap(pc.magenta),
    cyan: wrap(pc.cyan),
    grey: wrap(pc.gray),
};

/**
 * One report line on stdout. Always appends a newline, exactly like `console.log` — several
 * blocks here already end in `\n` to leave a blank line after themselves, and `out.println`
 * would swallow that second newline and collapse the spacing.
 */
export function line(text: string | number = ""): void {
    out.print(`${text}\n`);
}

export const visibleLength = (s: string) => stripAnsi(s).length;

export function truncate(s: string, max: number): string {
    if (max <= 1 || visibleLength(s) <= max) {
        return s;
    }

    return `${stripAnsi(s).slice(0, max - 1)}…`;
}

export function pad(s: string, width: number, align: "l" | "r" = "l"): string {
    const gap = Math.max(0, width - visibleLength(s));

    return align === "r" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

export interface Column {
    head: string;
    align?: "l" | "r";
    max?: number;
}

export function table(cols: Column[], rows: (string | number)[][]): string {
    const cells = rows.map((r) => r.map((v) => String(v)));
    const widths = cols.map((col, i) => {
        const natural = Math.max(visibleLength(col.head), ...cells.map((r) => visibleLength(r[i] ?? "")), 1);

        return col.max ? Math.min(natural, col.max) : natural;
    });

    const line = (vals: string[], dim = false) => {
        const joined = vals
            .map((v, i) => pad(truncate(v, widths[i]!), widths[i]!, cols[i]!.align ?? "l"))
            .join("  ")
            .trimEnd();

        return dim ? c.grey(joined) : joined;
    };

    const head = line(
        cols.map((x) => x.head),
        true
    );
    const rule = c.grey(widths.map((w) => "─".repeat(w)).join("  "));

    return [head, rule, ...cells.map((r) => line(r))].join("\n");
}

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export function bar(value: number, max: number, width: number): string {
    if (max <= 0) {
        return "";
    }

    const units = Math.max(0, (value / max) * width * 8);
    const full = Math.floor(units / 8);
    const rest = Math.round(units % 8);

    return "█".repeat(full) + (rest ? BLOCKS[rest]! : "");
}

const SPARK = "▁▂▃▄▅▆▇█";

export function spark(values: number[]): string {
    if (!values.length) {
        return "";
    }

    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;

    return values.map((v) => SPARK[Math.min(7, Math.floor(((v - min) / span) * 7.999))]!).join("");
}

const HEAT = [" ", "·", "░", "▒", "▓", "█"];

export function heat(value: number, max: number): string {
    if (max <= 0 || value <= 0) {
        return HEAT[0]!;
    }

    const i = Math.min(HEAT.length - 1, 1 + Math.floor((value / max) * (HEAT.length - 1.001)));
    const ch = HEAT[i]!;
    if (i >= 5) {
        return c.red(ch);
    }

    if (i >= 4) {
        return c.yellow(ch);
    }

    if (i >= 3) {
        return c.green(ch);
    }

    return c.grey(ch);
}

export function heading(title: string, sub?: string): string {
    return `\n${c.bold(c.cyan(title))}${sub ? `  ${c.grey(sub)}` : ""}\n`;
}

export function keyValue(pairs: [string, string | number][]): string {
    const w = Math.max(...pairs.map(([k]) => k.length));

    return pairs.map(([k, v]) => `  ${c.grey(pad(k, w))}  ${v}`).join("\n");
}

/** Ratio rendered as a coloured bar plus its percentage, for score readouts. */
export function scoreBar(value01: number, width = 28): string {
    const filled = bar(value01, 1, width);
    const empty = "·".repeat(Math.max(0, width - visibleLength(filled)));
    const colour = value01 >= 0.66 ? c.green : value01 >= 0.33 ? c.yellow : c.red;

    return `${colour(filled)}${c.grey(empty)} ${colour(pct(value01))}`;
}
