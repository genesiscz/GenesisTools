/**
 * The language of a fenced code block in a PR note, as shiki names it, from the fence's info string
 * (```ts, ```tsx title="x", ```Shell). Nil: no colour (an unlabelled fence, or a language the page
 * does not load). Kept in step with the Swift side (`MarkdownContentView.fenceLanguage`).
 */
const aliases: Record<string, string> = {
    ts: "typescript",
    typescript: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "tsx",
    js: "javascript",
    javascript: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "jsx",
    json: "json",
    jsonc: "jsonc",
    json5: "json5",
    swift: "swift",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    shell: "bash",
    console: "bash",
    shellscript: "bash",
    yml: "yaml",
    yaml: "yaml",
    py: "python",
    python: "python",
    diff: "diff",
    patch: "diff",
    sql: "sql",
    css: "css",
    scss: "scss",
    html: "html",
    xml: "xml",
    go: "go",
    rust: "rust",
    rs: "rust",
    kotlin: "kotlin",
    kt: "kotlin",
    java: "java",
    php: "php",
    ruby: "ruby",
    rb: "ruby",
    toml: "toml",
    md: "markdown",
    markdown: "markdown",
    graphql: "graphql",
    gql: "graphql",
};

export function fenceLanguage(info: string): string | null {
    const word =
        info
            .trim()
            .split(/[\s{,]/)[0]
            ?.toLowerCase() ?? "";
    return aliases[word] ?? null;
}

/** "```tsx title=x" → the info after the backticks or tildes; null when the line opens no fence. */
export function fenceInfo(line: string): string | null {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    return match ? match[2].trim() : null;
}

export type FencedPart = { kind: "prose"; text: string } | { kind: "code"; text: string; language: string };

export function fencedParts(text: string): FencedPart[] {
    const parts = text.split(/```([a-zA-Z0-9_+-]*)[^\n]*\n?/);
    const result: FencedPart[] = [];

    // Both fences match: prose, opening language, code, closing language, prose.
    for (let index = 0; index < parts.length; index += 4) {
        const prose = parts[index];

        if (prose?.trim()) {
            result.push({ kind: "prose", text: prose.trim() });
        }

        const code = parts[index + 2];

        if (code?.trim()) {
            result.push({ kind: "code", text: code.replace(/\n$/, ""), language: parts[index + 1] ?? "" });
        }
    }

    return result;
}
