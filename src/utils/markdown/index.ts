import { alert } from "@mdit/plugin-alert";
import chalk, { type ChalkInstance } from "chalk";
import cliHtml from "cli-html";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
// @ts-expect-error - no types available for markdown-it-task-lists
import taskLists from "markdown-it-task-lists";
import { stripAnsi } from "@app/utils/string.js";

// ── Theme palette system ──────────────────────────────────────────────

export type ThemeName = "dark" | "light" | "minimal";

interface ThemePalette {
    mermaidHeader: ChalkInstance;
    mermaidBorder: ChalkInstance;
    mermaidLine: ChalkInstance;
    mermaidContent: ChalkInstance;
    tableBorder: ChalkInstance;
    tableHeader: ChalkInstance;
    alertColors: Record<string, string>;
    dim: ChalkInstance;
}

const themes: Record<ThemeName, ThemePalette> = {
    dark: {
        mermaidHeader: chalk.bgBlue.white.bold,
        mermaidBorder: chalk.blue,
        mermaidLine: chalk.cyan,
        mermaidContent: chalk.dim,
        tableBorder: chalk.dim,
        tableHeader: chalk.bold,
        alertColors: { important: "red", note: "blue", tip: "green", warning: "yellow", caution: "magenta" },
        dim: chalk.dim,
    },
    light: {
        mermaidHeader: chalk.bgCyan.black.bold,
        mermaidBorder: chalk.cyan,
        mermaidLine: chalk.blue,
        mermaidContent: chalk.gray,
        tableBorder: chalk.gray,
        tableHeader: chalk.bold,
        alertColors: { important: "redBright", note: "blueBright", tip: "greenBright", warning: "yellowBright", caution: "magentaBright" },
        dim: chalk.gray,
    },
    minimal: {
        mermaidHeader: chalk.bold,
        mermaidBorder: chalk.dim,
        mermaidLine: chalk.dim,
        mermaidContent: chalk.reset,
        tableBorder: chalk.dim,
        tableHeader: chalk.bold,
        alertColors: { important: "white", note: "white", tip: "white", warning: "white", caution: "white" },
        dim: chalk.dim,
    },
};

let currentPalette: ThemePalette = themes.dark;

// Languages that should NOT show line numbers (shell commands, config files, plain text)
const NO_LINE_NUMBER_LANGS = new Set([
    "", // no language specified - usually shell commands
    "bash",
    "sh",
    "shell",
    "zsh",
    "fish",
    "console",
    "terminal",
    "text",
    "plain",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "markdown",
    "md",
    "ini",
    "env",
    "diff",
]);

/**
 * Custom fence renderer with Mermaid support and smart line number handling.
 * - Mermaid diagrams are rendered as styled code blocks
 * - Shell/config blocks don't show line numbers
 * - Code blocks (ts, js, python, etc.) show line numbers
 */
function createFencePlugin(md: MarkdownIt): void {
    const defaultFence = md.renderer.rules.fence?.bind(md.renderer.rules);

    md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
        const token = tokens[idx];
        const code = token.content.trim();
        const info = token.info.trim().toLowerCase();

        // Check if it's a mermaid block
        if (info === "mermaid") {
            return renderMermaidBlock(code);
        }

        // Check for implicit mermaid (gantt, sequenceDiagram, graph)
        const firstLine = code.split(/\n/)[0].trim();
        if (
            firstLine === "gantt" ||
            firstLine === "sequenceDiagram" ||
            firstLine.match(/^graph (?:TB|BT|RL|LR|TD);?$/)
        ) {
            return renderMermaidBlock(code);
        }

        // For shell/config languages, disable line numbers via data attribute on <code>
        if (NO_LINE_NUMBER_LANGS.has(info)) {
            const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const langClass = info ? `class="language-${info}" ` : "";
            return `<pre><code ${langClass}data-cli-numbers-enabled="false">${escaped}</code></pre>\n`;
        }

        return defaultFence?.(tokens, idx, options, env, slf) ?? "";
    };
}

/**
 * Render a Mermaid diagram block for CLI display.
 */
function renderMermaidBlock(code: string): string {
    const p = currentPalette;
    const header = p.mermaidHeader(" 📊 MERMAID DIAGRAM ");
    const border = p.mermaidBorder("─".repeat(50));
    const lines = code.split("\n").map((line) => p.mermaidLine("  │ ") + p.mermaidContent(line));

    return `\n${header}\n${border}\n${lines.join("\n")}\n${border}\n`;
}

/**
 * Simple ASCII table renderer for markdown tables.
 * Bypasses cli-html's broken cli-table3 dependency.
 */
interface TableData {
    headers: string[];
    alignments: ("left" | "center" | "right")[];
    rows: string[][];
}

function parseTableTokens(tokens: Token[], startIdx: number): { data: TableData; endIdx: number } {
    const data: TableData = { headers: [], alignments: [], rows: [] };
    let idx = startIdx;

    // Helper to render inline tokens and strip HTML for plain text
    const renderInline = (inlineToken: Token): string => {
        if (!inlineToken.children) return inlineToken.content;
        // Render inline content and strip HTML tags for plain display
        let text = "";
        for (const child of inlineToken.children) {
            if (child.type === "text") {
                text += child.content;
            } else if (child.type === "code_inline") {
                text += child.content;
            } else if (child.type === "softbreak") {
                text += " ";
            }
        }
        return text;
    };

    while (idx < tokens.length && tokens[idx].type !== "table_close") {
        const token = tokens[idx];

        if (token.type === "thead_open") {
            // Parse header row
            idx++;
            while (idx < tokens.length && tokens[idx].type !== "thead_close") {
                if (tokens[idx].type === "th_open") {
                    const style = tokens[idx].attrGet("style") || "";
                    if (style.includes("text-align:center")) data.alignments.push("center");
                    else if (style.includes("text-align:right")) data.alignments.push("right");
                    else data.alignments.push("left");
                    idx++;
                    if (tokens[idx].type === "inline") {
                        data.headers.push(renderInline(tokens[idx]));
                    }
                }
                idx++;
            }
        } else if (token.type === "tbody_open") {
            idx++;
            while (idx < tokens.length && tokens[idx].type !== "tbody_close") {
                if (tokens[idx].type === "tr_open") {
                    const row: string[] = [];
                    idx++;
                    while (idx < tokens.length && tokens[idx].type !== "tr_close") {
                        if (tokens[idx].type === "td_open") {
                            idx++;
                            if (tokens[idx].type === "inline") {
                                row.push(renderInline(tokens[idx]));
                            }
                        }
                        idx++;
                    }
                    data.rows.push(row);
                }
                idx++;
            }
        }
        idx++;
    }

    return { data, endIdx: idx };
}

/**
 * Get the visual display width of a string, accounting for emojis and wide characters.
 */
function getDisplayWidth(str: string): number {
    // Simple approximation: count emoji as width 2, regular chars as 1
    // This handles most common cases without requiring external dependencies
    let width = 0;
    const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
    const matches = str.match(emojiRegex) || [];
    const emojiCount = matches.length;

    // Each emoji takes up ~2 character widths, but its length is 1-2
    // So we count non-emoji length + emoji width adjustment
    const withoutEmoji = str.replace(emojiRegex, "");
    width = withoutEmoji.length + emojiCount * 2;

    return width;
}

function renderAsciiTable(data: TableData): string {
    const { headers, alignments, rows } = data;
    if (headers.length === 0) return "";

    // Calculate column widths using display width
    const colWidths = headers.map((h, i) => {
        const cellWidths = [getDisplayWidth(h), ...rows.map((row) => getDisplayWidth(row[i] || ""))];
        return Math.max(...cellWidths);
    });

    // Pad cell content based on alignment using display width
    const padCell = (content: string, width: number, align: "left" | "center" | "right"): string => {
        const displayWidth = getDisplayWidth(content);
        const padding = width - displayWidth;
        if (padding <= 0) return content;

        if (align === "center") {
            const left = Math.floor(padding / 2);
            const right = padding - left;
            return " ".repeat(left) + content + " ".repeat(right);
        } else if (align === "right") {
            return " ".repeat(padding) + content;
        }
        return content + " ".repeat(padding);
    };

    // Build table lines
    const lines: string[] = [];

    const p = currentPalette;

    // Top border
    const topBorder = `┌${colWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
    lines.push(p.tableBorder(topBorder));

    // Header row
    const headerCells = headers.map((h, i) => padCell(h, colWidths[i], alignments[i] || "left"));
    lines.push(p.tableBorder("│ ") + p.tableHeader(headerCells.join(p.tableBorder(" │ "))) + p.tableBorder(" │"));

    // Header separator
    const headerSep = `├${colWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
    lines.push(p.tableBorder(headerSep));

    // Data rows
    for (const row of rows) {
        const cells = colWidths.map((w, i) => padCell(row[i] || "", w, alignments[i] || "left"));
        lines.push(p.tableBorder("│ ") + cells.join(p.tableBorder(" │ ")) + p.tableBorder(" │"));
    }

    // Bottom border
    const bottomBorder = `└${colWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;
    lines.push(p.tableBorder(bottomBorder));

    // Wrap in <pre> to prevent cli-html from wrapping the table
    return `\n<pre>${lines.join("\n")}</pre>\n`;
}

function createTablePlugin(md: MarkdownIt): void {
    // Override render to post-process tables with our ASCII renderer
    md.render = (src: string, env?: object): string => {
        const tokens = md.parse(src, env || {});
        let html = "";

        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type === "table_open") {
                const { data, endIdx } = parseTableTokens(tokens, i);
                html += renderAsciiTable(data);
                i = endIdx;
            } else {
                html += md.renderer.render([tokens[i]], md.options, env || {});
            }
        }

        return html;
    };
}

/**
 * Configure and create the markdown-it instance with plugins.
 */
function createMarkdownRenderer(): MarkdownIt {
    const md = new MarkdownIt({
        html: true,
        linkify: true,
        typographer: true,
    });

    // Add task list support (checkboxes)
    md.use(taskLists, { enabled: true });

    // Add GitHub-style alerts (> [!NOTE], > [!WARNING], etc.)
    md.use(alert, {
        deep: false,
        openRender: (tokens, index) => {
            const token = tokens[index];
            const color = currentPalette.alertColors[token.markup] || "blue";
            return `<blockquote style="border-left-color: ${color}">`;
        },
        closeRender: () => "</blockquote>\n",
        titleRender: (tokens, index) => {
            const token = tokens[index];
            const icons: Record<string, string> = {
                important: "❗",
                note: "ℹ️",
                tip: "💡",
                warning: "⚠️",
                caution: "🔴",
            };
            const icon = icons[token.markup] || "•";
            const title = token.content[0].toUpperCase() + token.content.slice(1).toLowerCase();
            return `<strong>${icon} ${title}</strong><br/>`;
        },
    });

    // Add custom fence handling (Mermaid + smart line numbers)
    createFencePlugin(md);

    // Add custom table rendering (bypasses cli-html's broken cli-table3)
    createTablePlugin(md);

    return md;
}

// Singleton instance
let mdInstance: MarkdownIt | null = null;

export interface MarkdownRenderOptions {
    /** Max output width in columns. Defaults to terminal width or 80. */
    width?: number;
    /** Color theme. Defaults to "dark". */
    theme?: "dark" | "light" | "minimal";
    /** Whether to include ANSI colors. Defaults to true. */
    color?: boolean;
}

function wrapToWidth(str: string, width: number): string {
    const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
    return str
        .split("\n")
        .map((line) => {
            // Use display width (emoji = 2 cols) for the early-exit check
            const plainLength = getDisplayWidth(stripAnsi(line));
            if (plainLength <= width) return line;
            // Walk the string, counting only visible characters
            let visible = 0;
            let i = 0;
            while (i < line.length && visible < width) {
                if (line[i] === "\x1b" && line[i + 1] === "[") {
                    // Skip entire ANSI escape sequence
                    const seqEnd = line.indexOf("m", i);
                    i = seqEnd === -1 ? line.length : seqEnd + 1;
                } else {
                    // Check if this char is wide (emoji/CJK)
                    const ch = line[i]!;
                    emojiRegex.lastIndex = 0; // reset stateful regex
                    const isWide = emojiRegex.test(ch);
                    const charWidth = isWide ? 2 : 1;
                    if (visible + charWidth > width) break;
                    visible += charWidth;
                    i++;
                }
            }
            return `${line.slice(0, i)}\x1b[0m`;
        })
        .join("\n");
}

/**
 * Render markdown content to CLI-friendly output.
 *
 * @param markdown - Raw markdown string
 * @param options - Optional render options for width, theme, and color control
 * @returns Formatted CLI string
 */
export function renderMarkdownToCli(markdown: string, options?: MarkdownRenderOptions): string {
    if (!mdInstance) {
        mdInstance = createMarkdownRenderer();
    }

    // Set active theme palette before rendering
    const themeName: ThemeName = options?.theme ?? "dark";
    currentPalette = themes[themeName];

    const html = mdInstance.render(markdown);
    let output = cliHtml(html);

    // Apply width constraint
    if (options?.width) {
        output = wrapToWidth(output, options.width);
    }

    // Strip colors if requested
    if (options?.color === false) {
        output = stripAnsi(output);
    }

    return output;
}

export default renderMarkdownToCli;
