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
    // Own keys only: "constructor" or "__proto__" in a PR's fence must not reach shiki as an object.
    return Object.hasOwn(aliases, word) ? aliases[word] : null;
}

/** "```tsx title=x" → the info after the backticks or tildes; null when the line opens no fence. */
export function fenceInfo(line: string): string | null {
    return fenceMarker(line)?.language ?? null;
}

export interface CodeFence {
    mark: string;
    width: number;
    language: string;
}

export function fenceMarker(line: string): CodeFence | null {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!opening || (opening[1][0] === "`" && opening[2].includes("`"))) {
        return null;
    }

    return { mark: opening[1][0], width: opening[1].length, language: opening[2].trim() };
}

export function fenceCloses(line: string, fence: CodeFence): boolean {
    const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    return closing !== null && closing[1][0] === fence.mark && closing[1].length >= fence.width;
}

export type FencedPart = { kind: "prose"; text: string } | { kind: "code"; text: string; language: string };

export function fencedParts(text: string): FencedPart[] {
    const result: FencedPart[] = [];
    let fence: CodeFence | null = null;
    let pending: string[] = [];
    const flush = () => {
        const body = pending.join("\n");

        if (body.trim()) {
            result.push(
                fence ? { kind: "code", text: body, language: fence.language } : { kind: "prose", text: body.trim() }
            );
        }

        pending = [];
    };

    for (const line of text.split("\n")) {
        if (fence) {
            if (fenceCloses(line, fence)) {
                flush();
                fence = null;
            } else {
                pending.push(line);
            }
        } else {
            const opening = fenceMarker(line);

            if (opening) {
                flush();
                fence = opening;
            } else {
                pending.push(line);
            }
        }
    }

    flush();
    return result;
}
