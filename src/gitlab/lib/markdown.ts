/** One markdown table cell: pipes escaped, newlines flattened, null as empty. */
export function markdownCell(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

const FENCE_LANGUAGE: Record<string, string> = {
    ts: "ts",
    mts: "ts",
    cts: "ts",
    tsx: "tsx",
    js: "js",
    mjs: "js",
    cjs: "js",
    jsx: "jsx",
    json: "json",
    groovy: "groovy",
    md: "markdown",
    patch: "diff",
    diff: "diff",
    podspec: "ruby",
    rb: "ruby",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    m: "objectivec",
    swift: "swift",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
    css: "css",
    scss: "scss",
    html: "html",
    php: "php",
};

/** Fence language from the file extension, so a terminal or viewer can colour the excerpt. */
export function fenceLanguage(path: string): string {
    const extension = path.split(".").pop()?.toLowerCase() ?? "";

    return FENCE_LANGUAGE[extension] ?? "text";
}
