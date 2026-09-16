import { extname } from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import type { ImportSite, ParsedModule, SideEffect, SideEffectKind } from "./types";

const LANG_BY_EXT: Record<string, Lang> = {
    ".ts": Lang.TypeScript,
    ".mts": Lang.TypeScript,
    ".cts": Lang.TypeScript,
    ".tsx": Lang.Tsx,
    ".js": Lang.JavaScript,
    ".mjs": Lang.JavaScript,
    ".cjs": Lang.JavaScript,
    ".jsx": Lang.Tsx,
};

export function languageFor(file: string): Lang | undefined {
    return LANG_BY_EXT[extname(file)];
}

/** Ancestor kinds whose body runs later than module evaluation. */
const DEFERRED_KINDS = new Set([
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
    "method_definition",
    "class_body",
]);

/** `static x = …` (TS `public_field_definition`, JS `field_definition`). */
function isStaticField(node: SgNode): boolean {
    const kind = String(node.kind());

    if (kind !== "field_definition" && kind !== "public_field_definition") {
        return false;
    }

    return node.children().some((child) => child.kind() === "static");
}

/** Class members whose initializers run when the class is evaluated. */
function isStaticClassEval(node: SgNode): boolean {
    return String(node.kind()) === "class_static_block" || isStaticField(node);
}

function staticFieldValue(node: SgNode): SgNode | null {
    const kids = node.children();
    let afterEq = false;

    for (const child of kids) {
        if (afterEq) {
            return child;
        }

        if (child.kind() === "=") {
            afterEq = true;
        }
    }

    return null;
}

/** A `static { … }` block or `static x = …` field runs at evaluation time; methods and instance fields do not. */
function runsAtModuleScope(node: SgNode): boolean {
    let insideStatic = false;

    for (const ancestor of node.ancestors()) {
        const kind = String(ancestor.kind());

        if (isStaticClassEval(ancestor)) {
            insideStatic = true;
            continue;
        }

        if (kind === "class_body" && insideStatic) {
            insideStatic = false;
            continue;
        }

        if (DEFERRED_KINDS.has(kind)) {
            return false;
        }
    }

    return true;
}

/** `await import()` that itself runs at module scope blocks evaluation. */
function isAwaitedAtModuleScope(call: SgNode): boolean {
    for (const ancestor of call.ancestors()) {
        if (String(ancestor.kind()) === "await_expression") {
            return runsAtModuleScope(ancestor);
        }
    }

    return false;
}

function field(node: SgNode, name: string): SgNode | null {
    type FieldAccessor = (fieldName: string) => SgNode | null;
    return (node.field as FieldAccessor)(name);
}

function stringValue(node: SgNode): string | null {
    const fragment = node.find({ rule: { kind: "string_fragment" } });
    return fragment ? fragment.text() : null;
}

function lineOf(node: SgNode): number {
    return node.range().start.line + 1;
}

function readImportClause(clause: SgNode): { names: string[]; locals: string[]; allTypes: boolean } {
    const names: string[] = [];
    const locals: string[] = [];
    let valueSpecifiers = 0;

    for (const child of clause.children()) {
        const kind = child.kind();

        if (kind === "identifier") {
            names.push("default");
            locals.push(child.text());
            valueSpecifiers++;
        } else if (kind === "namespace_import") {
            const local = child.children().find((c) => c.kind() === "identifier");
            names.push("*");
            locals.push(local ? local.text() : "*");
            valueSpecifiers++;
        } else if (kind === "named_imports") {
            for (const spec of child.children()) {
                if (spec.kind() !== "import_specifier") {
                    continue;
                }

                const parts = spec.children();
                const isType = parts.some((p) => p.kind() === "type");
                const identifiers = parts.filter((p) => p.kind() === "identifier" || p.kind() === "string");
                const imported = identifiers[0]?.text() ?? "";
                const local = identifiers[identifiers.length - 1]?.text() ?? imported;

                if (isType) {
                    continue;
                }

                names.push(imported.replace(/^["']|["']$/g, ""));
                locals.push(local);
                valueSpecifiers++;
            }
        }
    }

    return { names, locals, allTypes: valueSpecifiers === 0 };
}

function readImportStatement(node: SgNode): ImportSite | null {
    const source = node.children().find((c) => c.kind() === "string");

    if (!source) {
        return null;
    }

    const specifier = stringValue(source);

    if (specifier === null) {
        return null;
    }

    const statementIsType = node.children().some((c) => c.kind() === "type");
    const clause = node.children().find((c) => c.kind() === "import_clause");

    if (!clause) {
        return { specifier, kind: "side-effect", typeOnly: false, names: [], locals: [], line: lineOf(node) };
    }

    const read = readImportClause(clause);
    return {
        specifier,
        kind: "static",
        typeOnly: statementIsType || read.allTypes,
        names: read.names,
        locals: read.locals,
        line: lineOf(node),
    };
}

function readReexport(node: SgNode): ImportSite | null {
    const source = node.children().find((c) => c.kind() === "string");

    if (!source) {
        return null;
    }

    const specifier = stringValue(source);

    if (specifier === null) {
        return null;
    }

    const children = node.children();
    const statementIsType = children.some((c) => c.kind() === "type");
    const star = children.some((c) => c.kind() === "*" || c.kind() === "namespace_export");
    const names: string[] = [];

    if (star) {
        names.push("*");
    }

    const clause = children.find((c) => c.kind() === "export_clause");

    if (clause) {
        for (const spec of clause.children()) {
            if (spec.kind() !== "export_specifier") {
                continue;
            }

            if (spec.children().some((p) => p.kind() === "type")) {
                continue;
            }

            const first = spec.children().find((p) => p.kind() === "identifier" || p.kind() === "string");

            if (first) {
                names.push(first.text().replace(/^["']|["']$/g, ""));
            }
        }
    }

    return {
        specifier,
        kind: "reexport",
        typeOnly: statementIsType || (!star && names.length === 0),
        names,
        locals: [],
        line: lineOf(node),
    };
}

const DECLARATION_KINDS = new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "abstract_class_declaration",
    "lexical_declaration",
    "variable_declaration",
    "enum_declaration",
    "interface_declaration",
    "type_alias_declaration",
]);

/** Names an exported declaration binds. Type-level declarations bind nothing at runtime. */
function declaredNames(declaration: SgNode): string[] {
    const kind = declaration.kind();

    if (kind === "interface_declaration" || kind === "type_alias_declaration") {
        return [];
    }

    if (kind === "lexical_declaration" || kind === "variable_declaration") {
        const names: string[] = [];

        for (const declarator of declaration.children()) {
            if (declarator.kind() !== "variable_declarator") {
                continue;
            }

            const name = field(declarator, "name");

            if (!name) {
                continue;
            }

            if (name.kind() === "identifier") {
                names.push(name.text());
            } else {
                for (const inner of name.findAll({
                    rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier_pattern" }] },
                })) {
                    names.push(inner.text());
                }
            }
        }

        return names;
    }

    const name = field(declaration, "name");
    return name ? [name.text()] : [];
}

function calleeText(call: SgNode): string {
    const fn = field(call, "function") ?? call.child(0);
    return fn ? fn.text() : call.text();
}

const CALLEE_RULES: Array<[RegExp, SideEffectKind]> = [
    [/\b(setInterval|setTimeout|setImmediate|queueMicrotask)$/, "timer"],
    [/\bdlopen\b|\bffi\b|\bcc\b\(|\.node["']\)$/, "native"],
    [/\b(spawnSync|spawn|execSync|execFileSync|execFile|exec|Bun\.\$)$/, "spawn"],
    [
        /\b(readFileSync|readdirSync|existsSync|statSync|lstatSync|mkdirSync|writeFileSync|appendFileSync|openSync|realpathSync|accessSync|readlinkSync|Bun\.file)$/,
        "fs",
    ],
    [/\b(Database|sqlite|openDatabase|createDatabase)/i, "db"],
    [/\b(fetch|createServer|listen|connect|Bun\.serve|Bun\.listen)$/, "network"],
    [/\b(process\.on|process\.once|addEventListener|registerHook|register|on)$/, "hook"],
];

/**
 * Module-scope expressions that cost nothing worth reporting: collection literals, path
 * joins, colour wrappers, scoped loggers. Listing them would bury the one `new Database()`.
 */
const CHEAP_CALLEE =
    /^(?:new\s+)?(?:Set|Map|WeakMap|WeakSet|RegExp|Error|Date|URL|TextEncoder|TextDecoder|Intl\.\w+|Object\.(?:freeze|keys|values|entries|fromEntries|assign|create)|Array\.(?:from|of)|Buffer\.(?:from|alloc)|Symbol(?:\.for)?|String|Number|Boolean|BigInt|Math\.\w+|JSON\.\w+|SafeJSON\.\w+|pc\.\w+|chalk\.\w+|picocolors\.\w+|path\.\w+|join|resolve|dirname|basename|extname|relative|homedir|tmpdir|platform|process\.cwd|createRequire|fileURLToPath|pathToFileURL|promisify|profiler\.scope|logger\.scoped|logger\.child|createLogger|\w+\.bind|Object\.defineProperty|new\s+Command|new\s+Option|new\s+Set|Promise\.withResolvers|globalThis\.\w+|z\.\w+|zod\.\w+)$/;

function classifyValue(value: SgNode): SideEffect | null {
    const kind = value.kind();

    if (kind === "await_expression") {
        return { kind: "await", line: lineOf(value), text: squash(value.text()) };
    }

    if (kind === "new_expression") {
        const ctor = field(value, "constructor")?.text() ?? "";

        for (const [re, sideKind] of CALLEE_RULES) {
            if (re.test(`new ${ctor}`)) {
                return { kind: sideKind, line: lineOf(value), text: squash(value.text()) };
            }
        }

        if (CHEAP_CALLEE.test(`new ${ctor}`)) {
            return null;
        }

        return { kind: "construct", line: lineOf(value), text: squash(value.text()) };
    }

    if (kind === "call_expression") {
        const callee = calleeText(value);

        if (callee === "require" || callee === "import") {
            return null;
        }

        if (CHEAP_CALLEE.test(callee)) {
            return null;
        }

        for (const [re, sideKind] of CALLEE_RULES) {
            if (re.test(callee) || re.test(value.text())) {
                return { kind: sideKind, line: lineOf(value), text: squash(value.text()) };
            }
        }

        return { kind: "call", line: lineOf(value), text: squash(value.text()) };
    }

    if (kind === "assignment_expression" || kind === "augmented_assignment_expression") {
        return { kind: "assign", line: lineOf(value), text: squash(value.text()) };
    }

    if (kind === "parenthesized_expression" || kind === "as_expression" || kind === "satisfies_expression") {
        const inner = value.child(kind === "parenthesized_expression" ? 1 : 0);
        return inner ? classifyValue(inner) : null;
    }

    return null;
}

function squash(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine;
}

function isMainGuard(statement: SgNode): boolean {
    const condition = field(statement, "condition");
    return condition ? /import\.meta\.main/.test(condition.text()) : false;
}

function collectSideEffects(statement: SgNode, into: SideEffect[]): void {
    const kind = statement.kind();

    if (kind === "expression_statement") {
        const expr = statement.child(0);

        if (expr) {
            const effect = classifyValue(expr);

            if (effect) {
                into.push(effect);
            }
        }

        return;
    }

    if (kind === "lexical_declaration" || kind === "variable_declaration") {
        for (const declarator of statement.children()) {
            if (declarator.kind() !== "variable_declarator") {
                continue;
            }

            const value = field(declarator, "value");

            if (value) {
                const effect = classifyValue(value);

                if (effect) {
                    into.push(effect);
                }
            }
        }

        return;
    }

    if (kind === "export_statement") {
        const declaration = field(statement, "declaration");

        if (declaration) {
            collectSideEffects(declaration, into);
            return;
        }

        const value = field(statement, "value");

        if (value) {
            const effect = classifyValue(value);

            if (effect) {
                into.push(effect);
            }
        }

        return;
    }

    if (kind === "if_statement") {
        if (isMainGuard(statement)) {
            return;
        }

        for (const part of ["consequence", "alternative"]) {
            const branch = field(statement, part);

            if (branch) {
                collectSideEffects(branch, into);
            }
        }

        return;
    }

    if (kind === "else_clause") {
        for (const child of statement.children()) {
            collectSideEffects(child, into);
        }

        return;
    }

    if (kind === "try_statement") {
        const body = field(statement, "body");

        if (body) {
            collectSideEffects(body, into);
        }

        return;
    }

    if (kind === "statement_block") {
        for (const child of statement.children()) {
            collectSideEffects(child, into);
        }

        return;
    }

    if (kind === "for_statement" || kind === "for_in_statement" || kind === "while_statement") {
        into.push({ kind: "call", line: lineOf(statement), text: squash(statement.text()) });
        return;
    }

    if (kind === "class_declaration" || kind === "abstract_class_declaration") {
        const body = statement.children().find((child) => child.kind() === "class_body");

        if (!body) {
            return;
        }

        for (const child of body.children()) {
            const childKind = String(child.kind());

            if (childKind === "class_static_block") {
                collectSideEffects(child, into);
                continue;
            }

            if (isStaticField(child)) {
                const value = staticFieldValue(child);

                if (value) {
                    const effect = classifyValue(value);

                    if (effect) {
                        into.push(effect);
                    }
                }
            }
        }

        return;
    }

    if (kind === "class_static_block") {
        for (const child of statement.children()) {
            collectSideEffects(child, into);
        }
    }
}

/**
 * Static facts about one JS/TS module: every import edge with its names, what it re-exports,
 * what it runs at module scope, and which imported bindings it touches at module scope. One
 * ast-grep pass per file; nothing here resolves or times anything.
 */
export function parseModule(source: string, file: string): ParsedModule {
    const lang = languageFor(file) ?? Lang.TypeScript;
    const root = parse(lang, source).root();
    const imports: ImportSite[] = [];
    const reexports: ImportSite[] = [];
    const sideEffects: SideEffect[] = [];
    const reexportedLocals = new Set<string>();
    const exportNames = new Set<string>();
    let localExports = 0;

    for (const statement of root.children()) {
        const kind = statement.kind();

        if (kind === "import_statement") {
            const site = readImportStatement(statement);

            if (site) {
                imports.push(site);
            }

            continue;
        }

        if (kind === "export_statement") {
            const hasSource = statement.children().some((c) => c.kind() === "string");

            if (hasSource) {
                const site = readReexport(statement);

                if (site) {
                    reexports.push(site);
                    imports.push(site);
                }

                continue;
            }

            const declaration = field(statement, "declaration");

            if (declaration && DECLARATION_KINDS.has(String(declaration.kind()))) {
                localExports++;

                for (const name of declaredNames(declaration)) {
                    exportNames.add(name);
                }
            }

            const clause = statement.children().find((c) => c.kind() === "export_clause");

            if (clause) {
                for (const spec of clause.children()) {
                    if (spec.kind() === "export_specifier") {
                        const identifiers = spec.children().filter((p) => p.kind() === "identifier");
                        const local = identifiers[0];
                        const exported = identifiers[identifiers.length - 1];

                        if (local) {
                            reexportedLocals.add(local.text());
                        }

                        if (exported) {
                            exportNames.add(exported.text());
                        }
                    }
                }
            }

            const value = field(statement, "value");

            if (value) {
                exportNames.add("default");
            }

            if (value?.kind() === "identifier") {
                reexportedLocals.add(value.text());
            }
        }

        collectSideEffects(statement, sideEffects);
    }

    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
        const callee = calleeText(call);

        if (callee !== "require" && callee !== "import") {
            continue;
        }

        const args = field(call, "arguments");
        const first = args?.children().find((c) => c.kind() === "string");

        if (!first) {
            continue;
        }

        const specifier = stringValue(first);

        if (specifier === null) {
            continue;
        }

        const dynamic = callee === "import";
        const deferred = dynamic || !runsAtModuleScope(call);
        const awaited = dynamic && isAwaitedAtModuleScope(call);
        imports.push({
            specifier,
            kind: dynamic || deferred ? "dynamic" : "require",
            typeOnly: false,
            names: ["*"],
            locals: [],
            line: lineOf(call),
            ...(awaited ? { awaited: true } : {}),
        });
    }

    const locals = new Set<string>();

    for (const site of imports) {
        for (const local of site.locals) {
            if (local !== "*") {
                locals.add(local);
            }
        }
    }

    const moduleScopeUses = new Set<string>();

    if (locals.size > 0) {
        const candidates = root.findAll({
            rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier" }] },
        });

        for (const identifier of candidates) {
            const text = identifier.text();

            if (!locals.has(text) || moduleScopeUses.has(text)) {
                continue;
            }

            if (identifier.ancestors().some((a) => a.kind() === "import_statement")) {
                continue;
            }

            if (runsAtModuleScope(identifier)) {
                moduleScopeUses.add(text);
            }
        }
    }

    return {
        imports,
        reexports,
        localExports,
        exportNames,
        sideEffects,
        moduleScopeUses,
        reexportedLocals,
        bytes: Buffer.byteLength(source),
    };
}
