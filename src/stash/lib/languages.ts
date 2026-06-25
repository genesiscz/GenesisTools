import { extname } from "node:path";

export interface CommentSyntax {
    line: string | null;
    block: { open: string; close: string } | null;
}

const SLASH: CommentSyntax = { line: "//", block: { open: "/*", close: "*/" } };
const HASH: CommentSyntax = { line: "#", block: null };
const XML: CommentSyntax = { line: null, block: { open: "<!--", close: "-->" } };
const CSS: CommentSyntax = { line: null, block: { open: "/*", close: "*/" } };

const MAP: Record<string, CommentSyntax> = {
    ts: SLASH,
    tsx: SLASH,
    js: SLASH,
    jsx: SLASH,
    mjs: SLASH,
    cjs: SLASH,
    php: SLASH,
    java: SLASH,
    c: SLASH,
    h: SLASH,
    cpp: SLASH,
    hpp: SLASH,
    go: SLASH,
    rs: SLASH,
    swift: SLASH,
    kt: SLASH,
    scala: SLASH,
    dart: SLASH,
    py: HASH,
    rb: HASH,
    sh: HASH,
    bash: HASH,
    zsh: HASH,
    fish: HASH,
    yaml: HASH,
    yml: HASH,
    toml: HASH,
    html: XML,
    xml: XML,
    svg: XML,
    md: XML,
    vue: XML,
    css: CSS,
    scss: CSS,
    less: CSS,
};

export function commentSyntaxForFile(path: string): CommentSyntax {
    const ext = extname(path).slice(1).toLowerCase();
    return MAP[ext] ?? SLASH;
}
