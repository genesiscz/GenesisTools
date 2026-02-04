import MarkdownIt from "markdown-it";
import cliHtml from "cli-html";
import { alert } from "@mdit/plugin-alert";
// @ts-expect-error - no types available for markdown-it-task-lists
import taskLists from "markdown-it-task-lists";
import chalk from "chalk";

/**
 * Custom Mermaid fence renderer.
 * Since Mermaid diagrams can't be rendered in CLI, we display them
 * as styled code blocks with a header indicating it's a diagram.
 */
function createMermaidPlugin(md: MarkdownIt): void {
    const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules);

    md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
        const token = tokens[idx];
        const code = token.content.trim();
        const info = token.info.trim();

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

        return defaultFence(tokens, idx, options, env, slf);
    };
}

/**
 * Render a Mermaid diagram block for CLI display.
 */
function renderMermaidBlock(code: string): string {
    const header = chalk.bgBlue.white.bold(" 📊 MERMAID DIAGRAM ");
    const border = chalk.blue("─".repeat(50));
    const lines = code.split("\n").map((line) => chalk.cyan("  │ ") + chalk.dim(line));

    return `\n${header}\n${border}\n${lines.join("\n")}\n${border}\n`;
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
            const colors: Record<string, string> = {
                important: "red",
                note: "blue",
                tip: "green",
                warning: "yellow",
                caution: "magenta",
            };
            const color = colors[token.markup] || "blue";
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

    // Add Mermaid support
    createMermaidPlugin(md);

    return md;
}

// Singleton instance
let mdInstance: MarkdownIt | null = null;

/**
 * Render markdown content to CLI-friendly output.
 *
 * @param markdown - Raw markdown string
 * @returns Formatted CLI string
 */
export function renderMarkdownToCli(markdown: string): string {
    if (!mdInstance) {
        mdInstance = createMarkdownRenderer();
    }

    const html = mdInstance.render(markdown);
    return cliHtml(html);
}

export default renderMarkdownToCli;
