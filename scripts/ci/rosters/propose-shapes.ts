/**
 * The shapes the roster proposer counts (calls, imports, constructors, argv heads, state file names), the text a grep
 * looks for per shape, and the module a file belongs to. Shared by every proposer source.
 */

export type ShapeKind = "call" | "import" | "new" | "argv" | "declare" | "literal";

export interface Shape {
    kind: ShapeKind;
    /** The callee (`fetch`, `fs.unlinkSync`), module specifier, constructor, argv head (`launchctl`) or file name. */
    value: string;
}

/** Callees too common to mean anything as a roster. */
const NOISE = new Set([
    "if",
    "for",
    "while",
    "switch",
    "return",
    "function",
    "catch",
    "typeof",
    "expect",
    "describe",
    "test",
    "it",
    "push",
    "map",
    "filter",
    "join",
    "split",
    "slice",
    "includes",
    "has",
    "get",
    "set",
    "add",
    "String",
    "Number",
    "Boolean",
    "Array.isArray",
    "Object.keys",
    "Object.entries",
    "Object.values",
    "console.log",
    "console.error",
    "JSON.stringify",
    "JSON.parse",
    "SafeJSON.parse",
    "SafeJSON.stringify",
    "Math.max",
    "Math.min",
    "Math.round",
    "Date.now",
    "Promise.all",
    "log.debug",
    "log.info",
    "log.warn",
    "log.error",
    "out.log.info",
    "out.log.warn",
    "out.log.error",
    "trim",
    "replace",
    "toString",
    "then",
    "resolve",
    "require",
]);

/** Constructors of the language itself: never owned by a module. */
const BUILTIN_CLASSES = new Set(["Error", "Map", "Set", "Date", "URL", "RegExp", "Promise", "Array"]);

/** A call, not a constructor: `new X(` is the `new` shape. */
const CALL = /(?<![\w$.])(?<!new\s)((?:[A-Za-z_$][\w$]*\.){0,2}[A-Za-z_$][\w$]*)\s*\(/g;
const IMPORT = /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const NEW = /\bnew\s+([A-Z][\w$]*)\s*\(/g;
const ARGV = /\[\s*["']([a-z][a-z0-9-]{2,})["']\s*,/g;
const LITERAL = /["'`]([\w.-]+\.(?:jsonl?|db|sqlite|lock|pid|sock|plist))["'`]/g;

/** File names every tool uses for its own, unrelated file: a shared name, not a shared state file. */
const GENERIC_FILE_NAMES = new Set([
    "package.json",
    "tsconfig.json",
    "config.json",
    "settings.json",
    "manifest.json",
    "state.json",
    "index.db",
    "bun.lock",
    "package-lock.json",
    "composer.json",
    "composer.lock",
    "info.plist",
    "biome.json",
]);

/**
 * A state file name worth owning: `<stem>.<json|jsonl|db|sqlite|lock|pid|sock|plist>` whose stem has two words or
 * more (`cmux-refs.jsonl`, `chat_history.jsonl`, `historyIndex.db`), generic names left out. Pure.
 */
export function isStateFileName(name: string): boolean {
    if (
        !/^[\w.-]+\.(?:jsonl?|db|sqlite|lock|pid|sock|plist)$/.test(name) ||
        GENERIC_FILE_NAMES.has(name.toLowerCase())
    ) {
        return false;
    }

    const stem = name.slice(0, name.lastIndexOf("."));
    const words = stem
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[\s._-]+/)
        .filter((word) => /[A-Za-z]/.test(word));

    return words.length >= 2;
}

/** The shapes one source line holds. Pure. */
export function shapesOf(line: string): Shape[] {
    const shapes: Shape[] = [];
    const code = line.replace(/\/\/.*$/, "");

    for (const match of code.matchAll(CALL)) {
        const value = match[1];
        const last = value.split(".").at(-1) ?? value;

        if (!NOISE.has(value) && !NOISE.has(last) && !/^[A-Z][A-Z0-9_]*$/.test(value) && last.length > 2) {
            shapes.push({ kind: "call", value });
        }
    }

    for (const match of code.matchAll(IMPORT)) {
        const value = match[1] ?? match[2];

        if (value && !value.startsWith(".")) {
            shapes.push({ kind: "import", value });
        }
    }

    for (const match of code.matchAll(NEW)) {
        if (!BUILTIN_CLASSES.has(match[1])) {
            shapes.push({ kind: "new", value: match[1] });
        }
    }

    for (const match of code.matchAll(ARGV)) {
        shapes.push({ kind: "argv", value: match[1] });
    }

    for (const match of code.matchAll(LITERAL)) {
        if (isStateFileName(match[1])) {
            shapes.push({ kind: "literal", value: match[1] });
        }
    }

    return shapes;
}

export function shapeKey(shape: Shape): string {
    return `${shape.kind}:${shape.value}`;
}

const KINDS: readonly ShapeKind[] = ["call", "import", "new", "argv", "declare", "literal"];

export function parseShape(text: string): Shape {
    const [kind, ...rest] = text.split(":");
    const known = KINDS.find((candidate) => candidate === kind);

    if (!known || rest.length === 0) {
        throw new Error(`--scaffold takes <${KINDS.join("|")}>:<value>, got ${text}`);
    }

    return { kind: known, value: rest.join(":") };
}

/** The text a fixed-string grep looks for, for one shape. */
export function grepNeedle(shape: Shape): string {
    switch (shape.kind) {
        case "call":
            return `${shape.value}(`;
        case "import":
            return `"${shape.value}"`;
        case "new":
            return `new ${shape.value}(`;
        case "argv":
            return `"${shape.value}"`;
        case "declare":
            return `function ${shape.value}(`;
        case "literal":
            return shape.value;
    }
}

export function isTestPath(file: string): boolean {
    return /\.(?:test|spec)\.tsx?$/.test(file) || file.includes("/__tests__/");
}

/**
 * The module a file belongs to: `src/<tool>/` for a tool, `src/utils/<area>/` for the shared package, the file itself
 * for a single-file tool or a file directly under `src/utils/`. A folder ends with `/`. Pure.
 */
export function moduleOf(file: string): string {
    const parts = file.split("/");

    if (parts[0] !== "src" || parts.length < 3) {
        return file;
    }

    if (parts[1] === "utils") {
        return parts.length >= 4 ? `src/utils/${parts[2]}/` : file;
    }

    return `src/${parts[1]}/`;
}

/** The `allowedIn` regex source of a module (a folder prefix, or one exact file). Pure. */
export function allowedInSource(module: string): string {
    const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return module.endsWith("/") ? `^${escaped}` : `^${escaped}$`;
}

export interface TreeUsage {
    /** Tracked non-test files under src/ that hold the shape's text. */
    files: number;
    /** Lines that hold it, summed over those files. */
    matches: number;
}

const usageCache = new Map<string, TreeUsage>();

/** How often the tree still holds a shape (a fixed-string `git grep` of its text, tests left out). Cached. */
export function treeUsage(shape: Shape): TreeUsage {
    const needle = grepNeedle(shape);
    const cached = usageCache.get(needle);

    if (cached) {
        return cached;
    }

    const grep = Bun.spawnSync(["git", "grep", "-c", "-F", "-e", needle, "--", "src/*.ts", "src/*.tsx"]);

    if (grep.exitCode !== 0 && grep.exitCode !== 1) {
        throw new Error(`git grep failed: ${grep.stderr.toString()}`);
    }

    const rows = grep.stdout
        .toString()
        .split("\n")
        .filter((line) => line && !isTestPath(line.slice(0, line.lastIndexOf(":"))));
    const usage = {
        files: rows.length,
        matches: rows.reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(":") + 1)), 0),
    };
    usageCache.set(needle, usage);
    return usage;
}

export function countInTree(shape: Shape): number {
    return treeUsage(shape).matches;
}
