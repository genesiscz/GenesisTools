export interface BlockComment {
    open: string;
    close: string;
}

export interface CommentSyntax {
    line: string[];
    block: BlockComment[];
}

const SLASH_STAR: BlockComment = { open: "/*", close: "*/" };
const HTML_BLOCK: BlockComment = { open: "<!--", close: "-->" };

const EXT_TO_LANGUAGE: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    py: "Python",
    go: "Go",
    rs: "Rust",
    java: "Java",
    kt: "Kotlin",
    rb: "Ruby",
    php: "PHP",
    c: "C",
    h: "C",
    cpp: "C++",
    cc: "C++",
    hpp: "C++",
    cs: "C#",
    swift: "Swift",
    css: "CSS",
    scss: "SCSS",
    sass: "Sass",
    less: "Less",
    html: "HTML",
    htm: "HTML",
    vue: "Vue",
    svelte: "Svelte",
    md: "Markdown",
    json: "JSON",
    jsonc: "JSON",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
    sql: "SQL",
    lua: "Lua",
    xml: "XML",
    svg: "SVG",
    twig: "Twig",
    blade: "Blade",
    stub: "Stub",
    ini: "INI",
    conf: "INI",
    env: "INI",
    neon: "NEON",
    txt: "Text",
    log: "Text",
    lock: "Lock",
    mdc: "Markdown",
    csv: "CSV",
    graphql: "GraphQL",
    gql: "GraphQL",
    prisma: "Prisma",
    proto: "Protobuf",
    dockerfile: "Docker",
    makefile: "Makefile",
};

const C_LIKE = new Set([
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "jsonc",
    "go",
    "rs",
    "java",
    "kt",
    "c",
    "h",
    "cpp",
    "cc",
    "hpp",
    "cs",
    "swift",
    "php",
    "scss",
    "sass",
    "less",
    "vue",
    "svelte",
]);

const HASH_LINE = new Set([
    "py",
    "rb",
    "sh",
    "bash",
    "zsh",
    "yaml",
    "yml",
    "toml",
    "ini",
    "conf",
    "env",
    "neon",
    "graphql",
    "gql",
    "dockerfile",
    "makefile",
]);
const DASH_LINE = new Set(["sql", "lua"]);
const HTML_LIKE = new Set(["html", "htm", "md", "mdc", "vue", "svelte", "xml", "svg"]);

function normalizeExt(ext: string): string {
    return ext.replace(/^\./, "").toLowerCase();
}

export function resolveLanguage(ext: string): string {
    const key = normalizeExt(ext);
    return EXT_TO_LANGUAGE[key] ?? "Other";
}

export function commentSyntaxForExt(ext: string): CommentSyntax {
    const key = normalizeExt(ext);
    const line: string[] = [];
    const block: BlockComment[] = [];

    if (C_LIKE.has(key)) {
        line.push("//");
        block.push(SLASH_STAR);
    }

    if (HASH_LINE.has(key)) {
        line.push("#");
    }

    if (DASH_LINE.has(key)) {
        line.push("--");
    }

    if (key === "css") {
        block.push(SLASH_STAR);
    }

    if (key === "prisma" || key === "proto") {
        line.push("//");
        block.push(SLASH_STAR);
    }

    if (key === "ini") {
        line.push(";");
    }

    if (key === "twig") {
        block.push({ open: "{#", close: "#}" });
    }

    if (key === "blade") {
        block.push({ open: "{{--", close: "--}}" });
        block.push(HTML_BLOCK);
    }

    if (HTML_LIKE.has(key)) {
        block.push(HTML_BLOCK);
    }

    return { line, block };
}
