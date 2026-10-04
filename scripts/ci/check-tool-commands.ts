#!/usr/bin/env bun
/**
 * Every `tools …` command that hint text names must still exist.
 *
 * Hint text names commands through `toolCommand("macos permissions build")` or
 * `suggestCommand("tools macos", { replaceCommand: ["permissions", "build"] })`. A plain string such
 * as "Run `tools macos permissions build`" kept pointing at a command after it was renamed, and
 * nothing noticed until a user typed it. This guard parses every source file (the TypeScript syntax
 * API, no type checker) and checks each named command against the tree:
 *
 * - the first word is a tool: a `src/<tool>` entry (letter case ignored, as the macOS dispatcher
 *   does), or an alias in the root `tools` dispatcher;
 * - each following command word is registered under that tool: `.command("<word>")`,
 *   `.alias(…)`, `.aliases([…])`, `new Command("<word>")`, `buildGroup("<word>")`, a
 *   `commandName: "<word>"` registry entry, or a lazy registrar key (`clones: async () => import(…)`),
 *   in `src/<tool>/**` or in a module the tool imports (`@app/<other>/…`, `@genesiscz/utils/…`).
 *
 * It stops at the first word that is not a command word (`--flag`, `<value>`) and after a command
 * that takes positional arguments (`.command("add <name>")`, or a chained `.argument(…)`), because
 * what follows is a value. A path built at runtime is skipped. Exit codes: 0 clean, 1 a stale
 * reference or a broken scan, never anything else.
 *
 * Run: bun scripts/ci/check-tool-commands.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { out } from "@genesiscz/utils/logger";
import { calleeName, parseSource, stringValue, unwrap, walk } from "@genesiscz/utils/ts/source/parse";
import { resolveSpecifier } from "@genesiscz/utils/ts/source/resolve";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;

export interface ToolCommandRef {
    file: string;
    line: number;
    command: string;
    via: "toolCommand" | "suggestCommand";
}

export interface CommandIndex {
    hasTool(tool: string): boolean;
    alias(tool: string): string[] | undefined;
    commandWords(tool: string): ReadonlySet<string>;
    /** Command words declared with positional arguments: what follows them is a value. */
    argumentCommands?(tool: string): ReadonlySet<string>;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** `const TOOL = "tools notify"` declarations of the file: name → the path after `tools `. */
function toolNameConstants(source: ts.SourceFile): Map<string, string> {
    const constants = new Map<string, string>();

    walk(source, (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const value = stringValue(node.initializer);

            if (value?.startsWith("tools ")) {
                constants.set(node.name.text, value.slice("tools ".length).trim());
            }
        }
    });

    return constants;
}

/** The leading string-literal words of the call's `replaceCommand: [...]` option. */
function replaceCommandWords(options: ts.Expression | undefined): string[] {
    if (!options || !ts.isObjectLiteralExpression(options)) {
        return [];
    }

    for (const property of options.properties) {
        if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "replaceCommand" &&
            ts.isArrayLiteralExpression(property.initializer)
        ) {
            const words: string[] = [];

            for (const element of property.initializer.elements) {
                const value = stringValue(element);

                if (value === undefined) {
                    break;
                }

                words.push(value);
            }

            return words;
        }
    }

    return [];
}

/**
 * Every literal command path in `text`, with its 1-based line: `toolCommand("…")`, and
 * `suggestCommand("tools …")` (or a same-file `const X = "tools …"`) followed by the leading
 * string literals of its `replaceCommand`.
 */
export function findToolCommandRefs(file: string, text: string): ToolCommandRef[] {
    const { source } = parseSource(file.endsWith(".tsx") ? file : `${file.replace(/\.tsx?$/, "")}.ts`, text);
    const constants = toolNameConstants(source);
    const refs: ToolCommandRef[] = [];

    walk(source, (node) => {
        if (!ts.isCallExpression(node)) {
            return;
        }

        const name = calleeName(node);
        const [first, options] = node.arguments;

        if (name === "toolCommand") {
            const command = stringValue(first)?.trim();

            if (command) {
                refs.push({ file, line: lineOf(source, node), command, via: "toolCommand" });
            }

            return;
        }

        if (name !== "suggestCommand" || !first) {
            return;
        }

        const literal = stringValue(first);
        const target = unwrap(first);
        const base = literal?.startsWith("tools ")
            ? literal.slice("tools ".length).trim()
            : ts.isIdentifier(target)
              ? constants.get(target.text)
              : undefined;

        if (base) {
            const command = [base, ...replaceCommandWords(options)].join(" ");
            refs.push({ file, line: lineOf(source, node), command, via: "suggestCommand" });
        }
    });

    return refs.sort((a, b) => a.line - b.line);
}

export interface HardcodedCommand {
    file: string;
    line: number;
    text: string;
}

const HARDCODED = /(?:^|[^\w-])tools ([a-z][a-z0-9-]*)/g;
const HELPER_CALLS = new Set(["toolCommand", "suggestCommand", "suggestEnumFlag"]);
const TOOL_NAME_CONSTANT = /^tools [a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/;

/** The literal text a node carries: a string, a template part, or JSX text. */
function literalText(node: ts.Node): string | undefined {
    if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)
    ) {
        return node.text;
    }

    return undefined;
}

/**
 * Every string, template part or JSX text that names `tools <tool>` without going through a helper.
 * The tools-name argument of `suggestCommand`/`toolCommand`/`suggestEnumFlag`, and a
 * `const TOOL = "tools <path>"` constant that feeds one, are the helpers' own input and are skipped.
 */
export function findHardcodedToolCommands(
    file: string,
    text: string,
    isTool: (name: string) => boolean
): HardcodedCommand[] {
    const { source } = parseSource(file.endsWith(".tsx") ? file : `${file.replace(/\.tsx?$/, "")}.ts`, text);
    const hits: HardcodedCommand[] = [];
    const sourceLines = text.split("\n");

    walk(source, (node) => {
        const value = literalText(node);

        if (value === undefined) {
            return;
        }

        const parent = node.parent;

        if (ts.isCallExpression(parent) && HELPER_CALLS.has(calleeName(parent) ?? "") && parent.arguments[0] === node) {
            return;
        }

        if (ts.isVariableDeclaration(parent) && TOOL_NAME_CONSTANT.test(value)) {
            return;
        }

        if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
            return;
        }

        const line = lineOf(source, node);

        // Prose that happens to read "tools <tool>" opts out on its line, with a reason.
        if (sourceLines[line - 1]?.includes("check-tool-commands-ignore")) {
            return;
        }

        for (const match of value.matchAll(HARDCODED)) {
            if (isTool(match[1])) {
                hits.push({ file, line, text: value.trim().replace(/\s+/g, " ").slice(0, 140) });
                return;
            }
        }
    });

    return hits;
}

/** Null when `ref` names a command that exists, otherwise the error line. */
export function checkRef(ref: ToolCommandRef, index: CommandIndex): string | null {
    let words = ref.command.split(/\s+/).filter(Boolean);
    const alias = index.alias(words[0] ?? "");

    if (alias) {
        words = [...alias, ...words.slice(1)];
    }

    const [tool, ...rest] = words;
    const where = `${ref.file}:${ref.line}`;

    if (!tool || !index.hasTool(tool)) {
        return `${where} names \`tools ${ref.command}\`, but there is no src/${tool} entry or dispatcher alias "${tool}"`;
    }

    const registered = index.commandWords(tool);
    const takesArguments = index.argumentCommands?.(tool) ?? new Set<string>();

    for (const word of rest) {
        if (!COMMAND_WORD.test(word)) {
            break;
        }

        if (!registered.has(word)) {
            return `${where} names \`tools ${ref.command}\`, but no command "${word}" is registered under src/${tool}`;
        }

        if (takesArguments.has(word)) {
            break;
        }
    }

    return null;
}

interface Registrations {
    words: Set<string>;
    takesArguments: Set<string>;
}

const REGISTERING_CALLS = new Set(["command", "alias", "buildGroup"]);

/** The `.command("<word>")` a chained call such as `.argument(…)` hangs off, if any. */
function chainedCommandWord(expression: ts.Expression): string | undefined {
    let current = unwrap(expression);

    while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
        if (ts.isCallExpression(current) && calleeName(current) === "command") {
            return stringValue(current.arguments[0])?.split(/\s+/)[0];
        }

        current = unwrap(current.expression);
    }

    return undefined;
}

function hasDynamicImport(node: ts.Node): boolean {
    let found = false;

    walk(node, (child) => {
        if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
            found = true;
        }
    });

    return found;
}

function propertyKey(name: ts.PropertyName): string | undefined {
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** Records the command words a source file registers; returns the modules it imports, static and dynamic. */
function scanSourceFile(path: string, into: Registrations): string[] {
    const { source } = parseSource(path, readFileSync(path, "utf8"));
    const modules: string[] = [];

    const add = (declared: string | undefined): void => {
        const word = declared?.split(/\s+/)[0];

        if (word && COMMAND_WORD.test(word)) {
            into.words.add(word);

            if (declared && /[<[]/.test(declared)) {
                into.takesArguments.add(word);
            }
        }
    };

    walk(source, (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const specifier = stringValue(node.moduleSpecifier);

            if (specifier) {
                modules.push(specifier);
            }

            return;
        }

        if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const specifier = stringValue(node.arguments[0]);

                if (specifier) {
                    modules.push(specifier);
                }

                return;
            }

            const name = calleeName(node);
            const [first] = node.arguments;

            if (name && REGISTERING_CALLS.has(name)) {
                add(stringValue(first));
            } else if (name === "aliases" && first && ts.isArrayLiteralExpression(first)) {
                for (const element of first.elements) {
                    add(stringValue(element));
                }
            } else if (
                (name === "argument" || name === "arguments") &&
                ts.isPropertyAccessExpression(node.expression)
            ) {
                const word = chainedCommandWord(node.expression.expression);

                if (word) {
                    into.takesArguments.add(word);
                }
            }

            return;
        }

        if (ts.isNewExpression(node) && calleeName(node) === "Command") {
            add(stringValue(node.arguments?.[0]));
            return;
        }

        if (ts.isPropertyAssignment(node)) {
            const key = propertyKey(node.name);

            if (key === "commandName") {
                add(stringValue(node.initializer));
            } else if (
                key &&
                ts.isArrowFunction(node.initializer) &&
                node.initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
                hasDynamicImport(node.initializer)
            ) {
                add(key);
            }
        }
    });

    return modules;
}

function sourceFiles(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    const files: string[] = [];

    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) {
            continue;
        }

        const path = join(dir, entry);

        if (statSync(path).isDirectory()) {
            files.push(...sourceFiles(path));
        } else if (/\.(ts|tsx)$/.test(entry)) {
            files.push(path);
        }
    }

    return files;
}

/** `src/utils/<path>` as a file: `<path>.ts`, `<path>.tsx` or its `index`. */
function utilsModuleFile(src: string, path: string): string | undefined {
    const base = join(src, "utils", path);

    return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((file) =>
        existsSync(file)
    );
}

/** `["voice-memos", ["macos", "voice-memos"]]` pairs of the root dispatcher's alias table. */
function dispatcherAliases(root: string): Map<string, string[]> {
    const aliases = new Map<string, string[]>();
    const dispatcher = join(root, "tools");

    if (!existsSync(dispatcher)) {
        return aliases;
    }

    const { source } = parseSource("tools.ts", readFileSync(dispatcher, "utf8"));

    walk(source, (node) => {
        if (!ts.isArrayLiteralExpression(node) || node.elements.length !== 2) {
            return;
        }

        const [name, target] = node.elements;
        const alias = stringValue(name);

        if (!alias || !ts.isArrayLiteralExpression(target) || target.elements.length === 0) {
            return;
        }

        const words: string[] = [];

        for (const element of target.elements) {
            const word = stringValue(element);

            if (word === undefined) {
                return;
            }

            words.push(word);
        }

        aliases.set(alias, words);
    });

    return aliases;
}

/** The tools, dispatcher aliases and registered command words of the tree at `root`. */
export function buildCommandIndex(root: string): CommandIndex {
    const src = join(root, "src");
    // Lowercased name → folder: the dispatcher finds `src/Internal` for `tools internal`, because
    // the macOS file system ignores letter case.
    const tools = new Map<string, string>();

    for (const entry of existsSync(src) ? readdirSync(src) : []) {
        const path = join(src, entry);

        if (statSync(path).isDirectory()) {
            if (existsSync(join(path, "index.ts")) || existsSync(join(path, "index.tsx"))) {
                tools.set(entry.toLowerCase(), entry);
            }
        } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
            const name = entry.replace(/\.tsx?$/, "");
            tools.set(name.toLowerCase(), name);
        }
    }

    const aliases = dispatcherAliases(root);
    const byTool = new Map<string, Registrations>();

    const registrations = (tool: string): Registrations => {
        const cached = byTool.get(tool);

        if (cached) {
            return cached;
        }

        const folder = tools.get(tool.toLowerCase()) ?? tool;
        const found: Registrations = { words: new Set(), takesArguments: new Set() };
        const extraFiles = new Set<string>();
        const utilsFiles = new Set<string>();

        for (const file of sourceFiles(join(src, folder))) {
            for (const specifier of scanSourceFile(file, found)) {
                const app = /^@app\/([^/]+)\//.exec(specifier)?.[1];

                if (app && app !== folder) {
                    for (const other of sourceFiles(join(src, app))) {
                        extraFiles.add(other);
                    }
                }

                const utils = /^@genesiscz\/utils\/(.+)$/.exec(specifier)?.[1];
                const module = utils ? utilsModuleFile(src, utils) : undefined;

                if (module) {
                    utilsFiles.add(module);
                }
            }
        }

        for (const file of extraFiles) {
            scanSourceFile(file, found);
        }

        // A utils module is often a barrel (`index.ts` re-exporting `./commander`): follow its
        // relative imports and re-exports one hop, where the registrations live.
        for (const file of utilsFiles) {
            for (const specifier of scanSourceFile(file, found)) {
                const resolved = specifier.startsWith(".")
                    ? resolveSpecifier({ from: file, specifier, exists: existsSync })
                    : null;

                if (resolved && !utilsFiles.has(resolved)) {
                    scanSourceFile(resolved, found);
                }
            }
        }

        byTool.set(tool, found);
        return found;
    };

    return {
        hasTool: (tool) => tools.has(tool.toLowerCase()) || aliases.has(tool),
        alias: (tool) => aliases.get(tool),
        commandWords: (tool) => registrations(tool).words,
        argumentCommands: (tool) => registrations(tool).takesArguments,
    };
}

/** Every stale reference in `files` (paths relative to `root`). */
export function checkTree(root: string, files: string[]): string[] {
    const index = buildCommandIndex(root);
    const errors: string[] = [];

    for (const file of files) {
        for (const ref of findToolCommandRefs(file, readFileSync(join(root, file), "utf8"))) {
            const error = checkRef(ref, index);

            if (error) {
                errors.push(error);
            }
        }
    }

    return errors;
}

function trackedSourceFiles(root: string): string[] {
    const result = Bun.spawnSync(["git", "ls-files", "src/**/*.ts", "src/**/*.tsx"], { cwd: root, stdout: "pipe" });

    if (result.exitCode !== 0) {
        throw new Error(`git ls-files failed (exit ${result.exitCode})`);
    }

    return result.stdout
        .toString()
        .split("\n")
        .filter((path) => path && !/\.test\.tsx?$/.test(path));
}

/** `--list-hardcoded [paths…]` prints the work list; `--strict` also fails on any hardcoded command. */
function hardcodedIn(root: string, files: string[]): HardcodedCommand[] {
    const index = buildCommandIndex(root);

    return files.flatMap((file) =>
        findHardcodedToolCommands(file, readFileSync(join(root, file), "utf8"), (name) => index.hasTool(name))
    );
}

if (import.meta.main) {
    try {
        const argv = process.argv.slice(2);
        const files = trackedSourceFiles(ROOT);

        if (argv[0] === "--list-hardcoded") {
            const prefixes = argv.slice(1);
            const scoped =
                prefixes.length > 0 ? files.filter((file) => prefixes.some((p) => file.startsWith(p))) : files;
            const hits = hardcodedIn(ROOT, scoped);

            for (const hit of hits) {
                out.println(`${hit.file}:${hit.line}  ${hit.text}`);
            }

            out.println(
                `check-tool-commands: ${hits.length} hardcoded command(s) in ${new Set(hits.map((hit) => hit.file)).size} file(s)`
            );
            process.exit(0);
        }

        const errors = checkTree(ROOT, files);

        for (const error of errors) {
            out.println(`× ${error}`);
        }

        const hardcoded = argv.includes("--strict") ? hardcodedIn(ROOT, files) : [];

        for (const hit of hardcoded) {
            out.println(
                `× ${hit.file}:${hit.line} names a command in a plain string; use toolCommand(…) or suggestCommand(…): ${hit.text}`
            );
        }

        if (errors.length > 0 || hardcoded.length > 0) {
            out.println(
                `check-tool-commands: ${errors.length} stale command reference(s), ${hardcoded.length} hardcoded command(s)`
            );
            process.exit(1);
        }

        out.println(`check-tool-commands: OK (${files.length} source files)`);
    } catch (error) {
        out.println(`check-tool-commands: scan failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
