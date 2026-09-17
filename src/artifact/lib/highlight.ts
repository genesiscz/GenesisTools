import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Syntax highlighting shared by the markdown renderer (fenced code, server AND
 * browser) and the kit's CodeBlock. highlight.js core plus a fixed language set
 * on purpose: the full build is 190 languages, of which an artifact page uses a
 * handful. Adding a language is one import, one row here, and nothing else,
 * because `HLJS_LANGUAGES` also feeds the dev server's prebundle list.
 *
 * Framework-free and free of node globals, like lib/markdown.ts, so the kit's
 * declaration emit (`types: []`) and the browser bundle both accept it.
 */
const LANGUAGES = {
    bash,
    css,
    diff,
    dockerfile,
    go,
    ini,
    javascript,
    json,
    markdown,
    php,
    plaintext,
    python,
    rust,
    shell,
    sql,
    swift,
    typescript,
    xml,
    yaml,
} as const;

/** Registered language ids (`highlight.js/lib/languages/<id>`). */
export const HLJS_LANGUAGES = Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[];

/** Fence names people actually type, mapped onto the registered ids. */
const ALIASES: Record<string, keyof typeof LANGUAGES> = {
    console: "shell",
    docker: "dockerfile",
    html: "xml",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    patch: "diff",
    py: "python",
    rs: "rust",
    sh: "bash",
    svg: "xml",
    text: "plaintext",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    txt: "plaintext",
    yml: "yaml",
    zsh: "bash",
};

for (const [name, language] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, language);
}

/** Resolve a fence/label language to a registered id, or null when unknown. */
export function resolveLanguage(lang: string | undefined): string | null {
    const first = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

    if (!first) {
        return null;
    }

    const id = ALIASES[first] ?? first;

    return hljs.getLanguage(id) ? id : null;
}

export interface HighlightedCode {
    /** Escaped HTML with `hljs-*` spans. */
    html: string;
    /** The registered language id that was applied. */
    language: string;
}

/**
 * Highlight `code`; null when the language is unknown, so the caller falls
 * back to its own escaping. The output is highlight.js's escaped markup and
 * never contains the source text raw.
 */
export function highlightCode(code: string, lang: string | undefined): HighlightedCode | null {
    const language = resolveLanguage(lang);

    if (!language) {
        return null;
    }

    return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
}
