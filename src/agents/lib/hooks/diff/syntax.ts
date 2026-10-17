import { basename } from "node:path";
import { hookDiag } from "../log";

type Rgb = readonly [number, number, number];

/**
 * Claude Code's dark syntax palette ("Monokai Extended"), read from the diff module of the 2.1.296
 * binary on 2026-10-15: highlight.js scope names, truecolor. A scope that is not here takes the nearest
 * ancestor that is, by its dotted prefix (`title.function` falls back to `title`), and one with no
 * ancestor keeps the text's default colour.
 */
const PALETTE: Record<string, Rgb> = {
    keyword: [249, 38, 114],
    operator: [249, 38, 114],
    built_in: [166, 226, 46],
    type: [166, 226, 46],
    title: [166, 226, 46],
    "title.function": [166, 226, 46],
    "title.class": [166, 226, 46],
    attr: [166, 226, 46],
    attribute: [166, 226, 46],
    literal: [190, 132, 255],
    number: [190, 132, 255],
    symbol: [190, 132, 255],
    string: [230, 219, 116],
    regexp: [230, 219, 116],
    params: [253, 151, 31],
    comment: [117, 113, 94],
    meta: [117, 113, 94],
    variable: [255, 255, 255],
    property: [255, 255, 255],
    punctuation: [248, 248, 242],
    subst: [248, 248, 242],
};

/** A `keyword` token with one of these words is a storage word, not a control keyword. */
const STORAGE_WORDS = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "type",
    "interface",
    "enum",
    "namespace",
    "module",
    "def",
    "fn",
    "func",
    "struct",
    "trait",
    "impl",
]);
const STORAGE: Rgb = [102, 217, 239];

/** The highlight.js language module for a file extension. Every module named here exists in highlight.js 11. */
const BY_EXTENSION: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    md: "markdown",
    markdown: "markdown",
    swift: "swift",
    py: "python",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    xml: "xml",
    svg: "xml",
    plist: "xml",
    yml: "yaml",
    yaml: "yaml",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    rb: "ruby",
    php: "php",
    sql: "sql",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    m: "objectivec",
    mm: "objectivec",
    lua: "lua",
    graphql: "graphql",
    gql: "graphql",
    toml: "ini",
    ini: "ini",
    diff: "diff",
    patch: "diff",
};
const BY_NAME: Record<string, string> = { Dockerfile: "dockerfile", Makefile: "makefile" };

/** The highlight.js language of a path, or `null` when this painter does not know it (`bat` then paints). */
export function languageOf(path: string): string | null {
    const name = basename(path);
    const named = BY_NAME[name];

    if (named) {
        return named;
    }

    const dot = name.lastIndexOf(".");

    return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

interface Engine {
    highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
    registerLanguage(name: string, language: unknown): void;
    getLanguage(name: string): unknown;
}

/** Missing optional modules fall back once, without repeated loads or diagnostics. */
export function createSyntaxEngineLoader(
    load: (name: string) => unknown = require
): (language: string) => Engine | null {
    let engine: Engine | undefined;
    const failed = new Set<string>();
    return (language) => {
        if (failed.has(language)) {
            return null;
        }
        try {
            engine ??= load("highlight.js/lib/core") as Engine;
            if (!engine) {
                throw new Error("highlight.js did not load");
            }
            if (!engine.getLanguage(language)) {
                engine.registerLanguage(language, load(`highlight.js/lib/languages/${language}`));
            }
            return engine;
        } catch (error) {
            failed.add(language);
            hookDiag("highlight.js language could not load, so bat does", { err: error, language });
            return null;
        }
    };
}

const engineFor = createSyntaxEngineLoader();

/** The xterm 256-colour index nearest to a colour: the grey ramp for greys, else the 6x6x6 cube. */
function nearest256([red, green, blue]: Rgb): number {
    if (red === green && green === blue) {
        if (red < 8) {
            return 16;
        }

        return red > 248 ? 231 : Math.round(((red - 8) / 247) * 24) + 232;
    }

    const level = (value: number) => Math.round((value / 255) * 5);

    return 16 + 36 * level(red) + 6 * level(green) + level(blue);
}

function colourCode(colour: Rgb, mode: "256" | "truecolor"): string {
    return mode === "truecolor"
        ? `\u001b[38;2;${colour[0]};${colour[1]};${colour[2]}m`
        : `\u001b[38;5;${nearest256(colour)}m`;
}

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
};

function decode(text: string): string {
    return text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * `hljs-title function_` is the scope `title.function`; `hljs-keyword` is `keyword`. The first class names
 * the scope and a later one ending in an underscore is its sub-scope.
 */
function scopeOf(classes: string): string {
    const [first = "", ...rest] = classes.split(" ");
    const base = first.startsWith("hljs-") ? first.slice(5) : first;
    const sub = rest.find((name) => name.endsWith("_"));

    return sub ? `${base}.${sub.slice(0, -1)}` : base;
}

function paletteColour(scope: string): Rgb | undefined {
    return PALETTE[scope] ?? PALETTE[scope.split(".")[0] ?? ""];
}

const TOKENS = /<span class="([^"]*)">|<\/span>|[^<]+/g;

/**
 * One syntax-coloured string per line of `text`, in the colours of Claude Code's own diff, or `null` when
 * the language is not one this painter has, highlight.js fails, or none of its scopes has a colour in this
 * palette (Markdown headings and bullets are not among the 24: `bat` colours them, so `bat` paints). Colours
 * are foreground only, each run
 * closed with `ESC[0m`; the caller runs the row through `compactColour`. A token that spans lines (a block
 * comment) is closed at the line end and opened again on the next line.
 */
export function syntaxRows({
    text,
    path,
    mode,
}: {
    text: string;
    path: string;
    mode: "256" | "truecolor";
}): string[] | null {
    const language = languageOf(path);

    if (!language) {
        return null;
    }

    try {
        const painter = engineFor(language);
        if (!painter) {
            return null;
        }
        const html = painter.highlight(text, { language, ignoreIllegals: true }).value;
        const stack: Array<{ scope: string; colour: Rgb | undefined }> = [];
        const rows: string[] = [];
        let row = "";

        for (const token of html.matchAll(TOKENS)) {
            if (token[1] !== undefined) {
                const scope = scopeOf(token[1]);

                stack.push({ scope, colour: paletteColour(scope) ?? stack.at(-1)?.colour });
                continue;
            }

            if (token[0] === "</span>") {
                stack.pop();
                continue;
            }

            const top = stack.at(-1);

            token[0].split("\n").forEach((piece, index) => {
                if (index > 0) {
                    rows.push(row);
                    row = "";
                }

                if (piece.length === 0) {
                    return;
                }

                const shown = decode(piece);
                const colour = top?.scope === "keyword" && STORAGE_WORDS.has(shown) ? STORAGE : top?.colour;

                row += colour ? `${colourCode(colour, mode)}${shown}\u001b[0m` : shown;
            });
        }

        rows.push(row);

        return rows.some((painted) => painted.includes("\u001b[")) ? rows : null;
    } catch (err) {
        hookDiag("highlight.js could not colour a diff, so bat does", { err, path });

        return null;
    }
}
