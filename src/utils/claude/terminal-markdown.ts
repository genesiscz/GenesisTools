import chalk from "chalk";
import { highlight } from "cli-highlight";
import { marked, Renderer } from "marked";

export function highlightCode(code: string, lang?: string): string {
    try {
        return highlight(code, {
            language: lang,
            ignoreIllegals: true,
        });
    } catch {
        return code;
    }
}

function createTerminalRenderer(): Renderer {
    const renderer = new Renderer();

    renderer.code = ({ text, lang }) => {
        return `\n${highlightCode(text, lang)}\n`;
    };

    renderer.codespan = ({ text }) => {
        return chalk.dim(text);
    };

    renderer.strong = ({ tokens }) => {
        return chalk.bold(renderer.parser.parseInline(tokens));
    };

    renderer.em = ({ tokens }) => {
        return chalk.italic(renderer.parser.parseInline(tokens));
    };

    renderer.heading = ({ tokens }) => {
        return `${chalk.bold(renderer.parser.parseInline(tokens))}\n`;
    };

    renderer.link = ({ href }) => {
        return chalk.underline(href);
    };

    renderer.paragraph = ({ tokens }) => {
        return `${renderer.parser.parseInline(tokens)}\n`;
    };

    renderer.list = (token) => {
        let result = "";
        const start = token.start ?? 1;

        for (const [index, item] of token.items.entries()) {
            const bullet = token.ordered ? `${start + index}. ` : "- ";
            const content = renderer.parser.parseInline(item.tokens);
            result += `${bullet}${content}\n`;
        }

        return result;
    };

    renderer.listitem = (item) => {
        return renderer.parser.parseInline(item.tokens);
    };

    renderer.blockquote = ({ tokens }) => {
        const inner = renderer.parser.parse(tokens);
        const lines = inner.split("\n");
        return `${lines.map((l) => `  ${chalk.dim("│")} ${l}`).join("\n")}\n`;
    };

    renderer.hr = () => `${"─".repeat(40)}\n`;

    renderer.br = () => "\n";

    renderer.html = ({ text }) => text;

    renderer.table = (token) => {
        const headerCells = token.header.map((cell) => chalk.bold(renderer.parser.parseInline(cell.tokens)));
        let result = `${headerCells.join("  ")}\n`;

        for (const row of token.rows) {
            const cells = row.map((cell) => renderer.parser.parseInline(cell.tokens));
            result += `${cells.join("  ")}\n`;
        }

        return result;
    };

    renderer.checkbox = ({ checked }) => (checked ? "[x] " : "[ ] ");

    renderer.del = ({ tokens }) => {
        return chalk.strikethrough(renderer.parser.parseInline(tokens));
    };

    renderer.image = ({ href }) => chalk.underline(href);

    renderer.text = (token) => {
        if ("tokens" in token && token.tokens) {
            return renderer.parser.parseInline(token.tokens);
        }

        return token.text;
    };

    renderer.space = () => "\n";

    renderer.def = () => "";

    return renderer;
}

const terminalRenderer = createTerminalRenderer();

export function renderMarkdown(text: string): string {
    const result = marked(text, { renderer: terminalRenderer, async: false }) as string;
    return result.replace(/\n{3,}/g, "\n\n").trimEnd();
}
