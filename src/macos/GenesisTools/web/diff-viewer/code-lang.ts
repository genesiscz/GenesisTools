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
