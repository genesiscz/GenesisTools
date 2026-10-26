// The checking process of `tools ts program`. It runs under node by default, because V8's heap is the one `tsc` and
// a reviewer's `ts.createProgram` live in, and it imports nothing from the repo: node cannot resolve the repo's path
// aliases, and the program checked is the TARGET project's, with that project's own `typescript`. That is why the
// protocol is environment in and one JSON file out, as in measure-worker.ts.
//
//   GT_TSP_CONFIG  absolute tsconfig path
//   GT_TSP_MODE    "phases" | "files" | "own" | "graph"
//   GT_TSP_FILES   for "own": the files to measure, one absolute path per line
//   GT_TSP_OUT     the result file

import { realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import type {
    CheckerCounts,
    FileCost,
    GraphFile,
    OwnCost,
    PhaseSample,
    ProgramMode,
    ProgramSize,
    SiteCost,
    WorkerResult,
} from "./types";

const MODES: readonly ProgramMode[] = ["phases", "files", "own", "graph", "sites"];

function isProgramMode(value: string): value is ProgramMode {
    return MODES.some((mode) => mode === value);
}

const configPath = process.env.GT_TSP_CONFIG ?? "";
const requestedMode = process.env.GT_TSP_MODE ?? "phases";
const outPath = process.env.GT_TSP_OUT ?? "";

if (!configPath || !outPath) {
    process.stderr.write("check-worker: GT_TSP_CONFIG and GT_TSP_OUT are required\n");
    process.exit(2);
}

if (!isProgramMode(requestedMode)) {
    process.stderr.write(`check-worker: unknown mode ${requestedMode}\n`);
    process.exit(2);
}

const mode: ProgramMode = requestedMode;

const configDir = dirname(configPath);
const ts = loadTypescript();
const started = performance.now();
const gc = findGc();

/** The project's own TypeScript (a reviewer runs that one), else the copy beside this tool. */
function loadTypescript(): typeof TS {
    for (const base of [configPath, import.meta.url]) {
        try {
            const require = createRequire(base);
            return require(require.resolve("typescript"));
        } catch {
            // Not resolvable from this base; the next one is tried.
        }
    }

    process.stderr.write(`check-worker: no typescript resolvable from ${configDir}\n`);
    process.exit(2);
}

/** A full collection: node's `--expose-gc` global, or Bun's. */
function findGc(): (() => void) | null {
    const nodeGc: unknown = Reflect.get(globalThis, "gc");

    if (typeof nodeGc === "function") {
        return () => {
            nodeGc();
            nodeGc();
        };
    }

    const bun: unknown = Reflect.get(globalThis, "Bun");
    const bunGc: unknown = bun && typeof bun === "object" ? Reflect.get(bun, "gc") : undefined;

    if (typeof bunGc === "function") {
        return () => bunGc.call(bun, true);
    }

    return null;
}

const MiB = 2 ** 20;

function sample(phase: PhaseSample["phase"]): PhaseSample {
    gc?.();
    const memory = process.memoryUsage();
    return {
        phase,
        heapMiB: Math.round(memory.heapUsed / MiB),
        rssMiB: Math.round(memory.rss / MiB),
        ms: Math.round(performance.now() - started),
    };
}

/** The config folder as the module resolver reports paths: macOS resolves /tmp and /var to /private/... */
const realConfigDir = realpathSync(configDir);

function display(file: string): string {
    for (const base of [configDir, realConfigDir]) {
        const rel = relative(base, file);

        if (!rel.startsWith("..") && !isAbsolute(rel)) {
            return rel;
        }
    }

    return file;
}

function parseConfig(): TS.ParsedCommandLine {
    const parsed = ts.getParsedCommandLineOfConfigFile(
        configPath,
        { noEmit: true },
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (d) => {
                process.stderr.write(`check-worker: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}\n`);
                process.exit(3);
            },
        }
    );

    if (!parsed) {
        process.exit(3);
    }

    return parsed;
}

function createProgram(parsed: TS.ParsedCommandLine, rootNames = parsed.fileNames): TS.Program {
    return ts.createProgram({
        rootNames,
        options: { ...parsed.options, noEmit: true, incremental: false, composite: false },
        projectReferences: parsed.projectReferences,
        // The config's own errors (an unknown option, an include that matches nothing); without them a broken
        // tsconfig reported 0 diagnostics.
        configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
    });
}

/** The counters live on the program; they read its checker's state. */
function counts(program: TS.Program): CheckerCounts {
    return {
        types: program.getTypeCount(),
        instantiations: program.getInstantiationCount(),
        symbols: program.getSymbolCount(),
    };
}

function size(program: TS.Program): ProgramSize {
    const result: ProgramSize = {
        files: 0,
        declarationFiles: 0,
        nodeModulesFiles: 0,
        nodeModulesBytes: 0,
        sourceBytes: 0,
    };

    for (const file of program.getSourceFiles()) {
        result.files++;
        result.sourceBytes += file.text.length;

        if (file.isDeclarationFile) {
            result.declarationFiles++;
        }

        if (file.fileName.includes("/node_modules/")) {
            result.nodeModulesFiles++;
            result.nodeModulesBytes += file.text.length;
        }
    }

    return result;
}

function formatDiagnostic(d: TS.Diagnostic): string {
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");

    if (!d.file || d.start === undefined) {
        return `TS${d.code}: ${message}`;
    }

    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${display(d.file.fileName)}(${line + 1},${character + 1}): TS${d.code}: ${message}`;
}

/** What `ts.createProgram` plus every diagnostic holds after each phase: what a reviewer's check needs. */
function phases(): WorkerResult {
    const samples = [sample("start")];
    const parsed = parseConfig();
    const program = createProgram(parsed);
    samples.push(sample("parse"));
    // Creating the checker binds every file.
    program.getTypeChecker();
    samples.push(sample("bind"));
    const diagnostics = [
        ...program.getConfigFileParsingDiagnostics(),
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getSyntacticDiagnostics(),
        ...program.getSemanticDiagnostics(),
    ];
    samples.push(sample("check"));
    return {
        mode: "phases",
        typescript: ts.version,
        runtime: runtimeName(),
        config: configPath,
        gcForced: gc !== null,
        size: size(program),
        phases: samples,
        diagnostics: diagnostics.length,
        firstDiagnostics: diagnostics.slice(0, 20).map(formatDiagnostic),
        ...counts(program),
    };
}

function checkOne(program: TS.Program, file: TS.SourceFile): FileCost {
    const before = counts(program);
    const start = performance.now();
    program.getSemanticDiagnostics(file);
    const after = counts(program);
    return {
        file: display(file.fileName),
        types: after.types - before.types,
        instantiations: after.instantiations - before.instantiations,
        symbols: after.symbols - before.symbols,
        ms: Math.round((performance.now() - start) * 10) / 10,
        bytes: file.text.length,
    };
}

/** Each file checked in program order, with what its check created. */
function files(): WorkerResult {
    const parsed = parseConfig();
    const program = createProgram(parsed);
    const rows = program
        .getSourceFiles()
        .filter((file) => !file.isDeclarationFile)
        .map((file) => checkOne(program, file));
    return {
        mode: "files",
        typescript: ts.version,
        runtime: runtimeName(),
        config: configPath,
        gcForced: gc !== null,
        size: size(program),
        rows,
        ...counts(program),
    };
}

/**
 * A program of the targets plus the config's own declaration files (ambient ones that nothing imports): every other
 * file is checked first, then each target, so a target's numbers are its own work, not its dependencies'.
 */
function own(): WorkerResult {
    const parsed = parseConfig();
    const targets = (process.env.GT_TSP_FILES ?? "")
        .split("\n")
        .filter(Boolean)
        .map((file) => resolve(file));
    const ambient = parsed.fileNames.filter((file) => file.endsWith(".d.ts"));
    const program = createProgram(parsed, [...targets, ...ambient]);
    const wanted = new Set(targets);

    for (const file of program.getSourceFiles()) {
        if (!wanted.has(resolve(file.fileName))) {
            program.getSemanticDiagnostics(file);
        }
    }

    const rows: OwnCost[] = [];

    for (const target of targets) {
        const file = program.getSourceFile(target);

        if (!file) {
            rows.push({
                file: display(target),
                types: 0,
                instantiations: 0,
                symbols: 0,
                ms: 0,
                bytes: 0,
                diagnostics: ["not in the program"],
            });
            continue;
        }

        const cost = checkOne(program, file);
        // A parse error is no semantic diagnostic, so a file that does not parse would otherwise read as clean.
        const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
        rows.push({ ...cost, diagnostics: diagnostics.map(formatDiagnostic) });
    }

    return {
        mode: "own",
        typescript: ts.version,
        runtime: runtimeName(),
        config: configPath,
        gcForced: gc !== null,
        rows,
    };
}

/**
 * Every module specifier a file names: import and export declarations, `import x = require()`, `import()` and
 * `require()` calls, and `import("…")` types. Each is resolved with its own resolution mode, because under
 * node16/nodenext an import and a require of one package can select different declaration files.
 */
/**
 * The module the compiler imports for JSX without an import in the source (`react/jsx-runtime` under
 * `jsx: react-jsx`). TypeScript adds it as a synthetic import that no AST walk sees, and its API does not
 * expose it. A file with no JSX may get an edge it does not need; that keeps a closure complete, never short.
 */
function jsxRuntimeSpecifier(file: TS.SourceFile, options: TS.CompilerOptions): string | undefined {
    if (!/\.[jt]sx$/.test(file.fileName)) {
        return undefined;
    }

    const pragma = /@jsxImportSource\s+(\S+)/.exec(file.text)?.[1];
    const automatic =
        options.jsx === ts.JsxEmit.ReactJSX || options.jsx === ts.JsxEmit.ReactJSXDev || options.jsxImportSource;

    if (!automatic && !pragma) {
        return undefined;
    }

    const runtime = options.jsx === ts.JsxEmit.ReactJSXDev ? "jsx-dev-runtime" : "jsx-runtime";
    return `${pragma ?? options.jsxImportSource ?? "react"}/${runtime}`;
}

function moduleSpecifiers(file: TS.SourceFile): TS.StringLiteralLike[] {
    const found: TS.StringLiteralLike[] = [];
    // TypeScript resolves `require("x")` as an import only in JavaScript files. In a .ts file the call is no import,
    // and before binding its string has no parent node, which `getModeForUsageLocation` needs.
    const requireImports = /\.[cm]?jsx?$/.test(file.fileName);
    const visit = (node: TS.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            if (ts.isStringLiteralLike(node.moduleSpecifier)) {
                found.push(node.moduleSpecifier);
            }
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            if (ts.isStringLiteralLike(node.moduleReference.expression)) {
                found.push(node.moduleReference.expression);
            }
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isLoader =
                callee.kind === ts.SyntaxKind.ImportKeyword ||
                (requireImports && ts.isIdentifier(callee) && callee.text === "require");
            const [first] = node.arguments;

            if (isLoader && first && ts.isStringLiteralLike(first)) {
                found.push(first);
            }
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            if (ts.isStringLiteralLike(node.argument.literal)) {
                found.push(node.argument.literal);
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(file);
    return found;
}

/**
 * The program's files and what each one imports or references, without checking. TypeScript keeps a file's resolved
 * imports internal, so the edges are resolved again with `resolveModuleName`, the program's options, a shared cache,
 * and each specifier's own mode (`getModeForUsageLocation`).
 */
function graph(): WorkerResult {
    const parsed = parseConfig();
    const program = createProgram(parsed);
    const options = program.getCompilerOptions();
    const cache = ts.createModuleResolutionCache(configDir, (name) => name, options);
    const sourceFiles = program.getSourceFiles();
    const index = new Map(sourceFiles.map((file, i) => [resolve(file.fileName), i]));
    const roots = new Set(program.getRootFileNames().map((file) => resolve(file)));
    const base = new Set<number>();

    for (const name of ts.getAutomaticTypeDirectiveNames(options, ts.sys)) {
        const resolved = ts.resolveTypeReferenceDirective(
            name,
            configPath,
            options,
            ts.sys
        ).resolvedTypeReferenceDirective;
        const at = resolved?.resolvedFileName ? index.get(resolve(resolved.resolvedFileName)) : undefined;

        if (at !== undefined) {
            base.add(at);
        }
    }

    const out: GraphFile[] = sourceFiles.map((file, i) => {
        const imports = new Set<number>();
        const add = (target: string | undefined) => {
            const at = target ? index.get(resolve(target)) : undefined;

            if (at !== undefined && at !== i) {
                imports.add(at);
            }
        };

        for (const specifier of moduleSpecifiers(file)) {
            const resolutionMode = ts.getModeForUsageLocation(file, specifier, options);
            add(
                ts.resolveModuleName(specifier.text, file.fileName, options, ts.sys, cache, undefined, resolutionMode)
                    .resolvedModule?.resolvedFileName
            );
        }

        const jsxRuntime = jsxRuntimeSpecifier(file, options);

        if (jsxRuntime) {
            add(
                ts.resolveModuleName(
                    jsxRuntime,
                    file.fileName,
                    options,
                    ts.sys,
                    cache,
                    undefined,
                    file.impliedNodeFormat
                ).resolvedModule?.resolvedFileName
            );
        }

        for (const ref of file.referencedFiles) {
            const target = resolve(dirname(file.fileName), ref.fileName);
            add(index.has(target) ? target : `${target}.d.ts`);
        }

        for (const ref of file.typeReferenceDirectives) {
            // A directive's own resolution-mode (or the file's module format) picks the import or require branch.
            const resolutionMode = ts.getModeForFileReference(ref, file.impliedNodeFormat);
            add(
                ts.resolveTypeReferenceDirective(
                    ref.fileName,
                    file.fileName,
                    options,
                    ts.sys,
                    undefined,
                    undefined,
                    resolutionMode
                ).resolvedTypeReferenceDirective?.resolvedFileName
            );
        }

        let bytes = file.text.length;

        try {
            bytes = statSync(file.fileName).size;
        } catch {
            // A lib file served from memory keeps its text length.
        }

        return {
            path: display(file.fileName),
            bytes,
            root: roots.has(resolve(file.fileName)),
            base: base.has(i) || program.isSourceFileDefaultLibrary(file),
            declaration: file.isDeclarationFile,
            imports: [...imports],
        };
    });

    return {
        mode: "graph",
        typescript: ts.version,
        runtime: runtimeName(),
        config: configPath,
        gcForced: gc !== null,
        files: out,
    };
}

/** Sites below this are not listed; across the GenesisTools root they held under a third of all instantiations. */
const SITE_MIN_INSTANTIATIONS = 50;

type SiteNode = TS.CallExpression | TS.NewExpression | TS.JsxOpeningLikeElement | TS.TypeReferenceNode;

interface SiteKey {
    key: string;
    external: boolean;
}

/** `name @ where`: a package file is named from inside its node_modules folder, a project file by its path. */
function declarationKey(checker: TS.TypeChecker, symbol: TS.Symbol | undefined): SiteKey | null {
    if (!symbol) {
        return null;
    }

    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.declarations?.[0];

    if (!declaration) {
        return { key: target.name, external: true };
    }

    const sourceFile = declaration.getSourceFile();
    const file = sourceFile.fileName;
    const at = file.lastIndexOf("/node_modules/");
    const external = at >= 0 || sourceFile.hasNoDefaultLib;
    return { key: `${target.name} @ ${at >= 0 ? file.slice(at + "/node_modules/".length) : display(file)}`, external };
}

function siteKey(checker: TS.TypeChecker, node: SiteNode): Pick<SiteCost, "kind" | "key" | "external"> {
    if (ts.isTypeReferenceNode(node)) {
        const found = declarationKey(checker, checker.getSymbolAtLocation(node.typeName));
        return { kind: "type", ...(found ?? { key: node.typeName.getText(), external: false }) };
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const type = checker.getTypeAtLocation(node.tagName);
        const alias = type.aliasSymbol ? declarationKey(checker, type.aliasSymbol) : null;
        return {
            kind: "jsx",
            key: `<${node.tagName.getText()}> : ${alias?.key ?? checker.typeToString(type).slice(0, 80)}`,
            external: alias?.external ?? false,
        };
    }

    const kind = ts.isNewExpression(node) ? "new" : "call";
    const declaration = checker.getResolvedSignature(node)?.declaration;
    const named = declaration && "name" in declaration && declaration.name ? declaration.name : undefined;
    const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
    const found =
        declarationKey(checker, named ? checker.getSymbolAtLocation(named) : undefined) ??
        declarationKey(checker, checker.getSymbolAtLocation(callee));
    return { kind, ...(found ?? { key: node.expression.getText().slice(0, 60), external: false }) };
}

/**
 * During the FIRST check of each project file, every call, `new`, JSX element and type reference is resolved on its
 * own and what it created is recorded; then the file's remaining checks run. Grouped by `key`, this ranks the APIs
 * and types that cost the most across the whole program. The first site to touch a library type pays for it, so a
 * cost repeated at many sites (a high median) is a code shape, and one large site is first use.
 *
 * ORDER: a call is resolved after its callee and BEFORE its arguments (a JSX element before its attributes), so an
 * argument's work (an object literal, a callback's returned value, a nested call) counts for the call that receives
 * it, the expression an edit changes. Arguments first would blame them for the outer call: an argument's contextual
 * type resolves the outer call, and `z.literal("native")` inside a `z.discriminatedUnion` took 81k instantiations
 * that way (2026-10-25). A method chain still costs per link, because each callee is resolved before its call.
 */
function sites(): WorkerResult {
    const parsed = parseConfig();
    const program = createProgram(parsed);
    const checker = program.getTypeChecker();
    const rows: SiteCost[] = [];

    for (const file of program.getSourceFiles()) {
        if (file.isDeclarationFile || file.fileName.includes("/node_modules/")) {
            continue;
        }

        const measure = (node: SiteNode): void => {
            const before = counts(program);
            const start = performance.now();

            try {
                if (ts.isTypeReferenceNode(node)) {
                    checker.getTypeFromTypeNode(node);
                } else {
                    checker.getResolvedSignature(node);
                }
            } catch {
                // A node the checker cannot resolve on its own is checked with its file below.
                return;
            }

            const after = counts(program);
            const instantiations = after.instantiations - before.instantiations;

            if (instantiations < SITE_MIN_INSTANTIATIONS) {
                return;
            }

            const ms = Math.round((performance.now() - start) * 10) / 10;
            const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
            rows.push({
                file: display(file.fileName),
                line: line + 1,
                ...siteKey(checker, node),
                instantiations,
                types: after.types - before.types,
                symbols: after.symbols - before.symbols,
                ms,
            });
        };
        const visitAll = (nodes: readonly TS.Node[] | undefined): void => nodes?.forEach(visit);
        const visit = (node: TS.Node): void => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                visit(node.expression);
                visitAll(node.typeArguments);
                measure(node);
                visitAll(node.arguments);
                return;
            }

            if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
                visit(node.tagName);
                visitAll(node.typeArguments);
                measure(node);
                visit(node.attributes);
                return;
            }

            ts.forEachChild(node, visit);

            if (ts.isTypeReferenceNode(node)) {
                measure(node);
            }
        };

        visit(file);
        program.getSemanticDiagnostics(file);
    }

    return {
        mode: "sites",
        typescript: ts.version,
        runtime: runtimeName(),
        config: configPath,
        gcForced: gc !== null,
        minInstantiations: SITE_MIN_INSTANTIATIONS,
        sites: rows,
        ...counts(program),
    };
}

function runtimeName(): string {
    const bun: unknown = Reflect.get(globalThis, "Bun");
    return bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
}

const run: Record<ProgramMode, () => WorkerResult> = { phases, files, own, graph, sites };
const result = run[mode]();

// biome-ignore lint/style/noRestrictedGlobals: a standalone node process cannot import SafeJSON from the repo
writeFileSync(outPath, JSON.stringify(result));
