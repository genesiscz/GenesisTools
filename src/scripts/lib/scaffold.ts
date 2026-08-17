/**
 * Scaffold generation.
 *
 * `tools scripts create` produces two files in `persisted/<name>/`:
 *
 *   <name>.tools.ts   generated typed wrappers, one function per matched tool,
 *                     argument types derived from the live inputSchema.
 *                     Regenerable, do not hand-edit.
 *   <name>.ts         the scratch script. Yours to edit.
 *
 * The split matters: regenerating bindings after a server updates its schema
 * must never touch the code you wrote.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import type { ToolInfo } from "./registry.ts";
import { allOptional, isEmptySchema, schemaToType } from "./schema-ts.ts";

export interface BoundTool {
    server: string;
    tool: ToolInfo;
    /** JS-safe function name, unique across servers. */
    fnName: string;
}

/** `chrome-devtools-mcp` + `take_screenshot` becomes `chromeDevtoolsMcp_takeScreenshot`. */
function camel(value: string): string {
    return value
        .replace(/[^A-Za-z0-9]+(.)?/g, (_, chr: string | undefined) => (chr ? chr.toUpperCase() : ""))
        .replace(/^[0-9]+/, "");
}

/**
 * A tool legitimately named `delete` or `new` would otherwise generate
 * `export const delete = ...`, a syntax error that breaks the whole module.
 * `eval` and `arguments` are not keywords but are equally illegal as lexical
 * declarations in strict mode, which every generated ES module is.
 */
const RESERVED_WORDS = new Set([
    "arguments",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
]);

export function bindNames(matches: { server: string; tool: ToolInfo }[]): BoundTool[] {
    const servers = new Set(matches.map((m) => m.server));
    const multiServer = servers.size > 1;
    const used = new Set<string>();

    return matches.map(({ server, tool }) => {
        const camelName = multiServer ? `${camel(server)}_${camel(tool.name)}` : camel(tool.name);
        const base = RESERVED_WORDS.has(camelName) ? `${camelName}Tool` : camelName;
        let name = base || "tool";
        let n = 2;

        while (used.has(name)) {
            name = `${base}${n}`;
            n += 1;
        }

        used.add(name);
        return { server, tool, fnName: name };
    });
}

function jsdoc(bound: BoundTool): string[] {
    const lines = ["/**"];
    const desc = (bound.tool.description ?? "").trim();

    if (desc) {
        for (const line of desc.split("\n").slice(0, 6)) {
            lines.push(` * ${line.replace(/\*\//g, "*\\/").trimEnd()}`);
        }

        lines.push(" *");
    }

    lines.push(` * MCP tool: \`${bound.server}.${bound.tool.name}\``);
    lines.push(" */");
    return lines;
}

export function renderToolsModule(bound: BoundTool[], selectors: string[], generatedAt: string): string {
    const servers = [...new Set(bound.map((b) => b.server))];
    const lines: string[] = [];

    lines.push("/**");
    lines.push(" * GENERATED FILE. Do not edit by hand.");
    lines.push(" *");
    lines.push(` * Selectors: ${selectors.join(", ")}`);
    lines.push(` * Servers:   ${servers.join(", ")}`);
    lines.push(` * Generated: ${generatedAt}`);
    lines.push(" *");
    lines.push(" * Regenerate after a server changes its schema:");
    lines.push(" *   tools scripts regen <name>");
    lines.push(" */");
    lines.push('import type { Kit } from "@gt/scripts/kit";');
    lines.push("");
    lines.push(`export const SERVERS = ${safeJsonArray(servers)} as const;`);
    lines.push("");

    for (const b of bound) {
        const argType = schemaToType(b.tool.inputSchema, 0);
        const empty = isEmptySchema(b.tool.inputSchema);
        const optional = empty || allOptional(b.tool.inputSchema);
        const typeName = `${b.fnName.charAt(0).toUpperCase()}${b.fnName.slice(1)}Args`;

        if (!empty) {
            lines.push(`export type ${typeName} = ${argType};`);
            lines.push("");
        }

        lines.push(...jsdoc(b));

        if (empty) {
            lines.push(`export const ${b.fnName} = (kit: Kit) =>`);
            lines.push(`    kit.call(${quote(b.server)}, ${quote(b.tool.name)});`);
        } else {
            lines.push(`export const ${b.fnName} = (kit: Kit, args${optional ? "?" : ""}: ${typeName}) =>`);
            lines.push(`    kit.call(${quote(b.server)}, ${quote(b.tool.name)}, args as Record<string, unknown>);`);
        }

        lines.push("");
    }

    lines.push("/** Every binding in this module, keyed by function name. */");
    lines.push("export const TOOLS = {");
    for (const b of bound) {
        lines.push(`    ${b.fnName},`);
    }

    lines.push("} as const;");
    lines.push("");
    return lines.join("\n");
}

/** JSON string escaping covers newlines and control characters too, which a hand-rolled quote-and-backslash replace does not. */
function quote(value: string): string {
    return SafeJSON.stringify(value, { strict: true });
}

function safeJsonArray(values: string[]): string {
    return `[${values.map(quote).join(", ")}]`;
}

export interface ScaffoldContext {
    name: string;
    description?: string;
    servers: string[];
    bound: BoundTool[];
    selectors: string[];
    createdFrom: string;
    project?: string;
    tags: string[];
}

export function renderScriptModule(ctx: ScaffoldContext): string {
    // Prefer a tool that needs no arguments for the starter line, so a freshly
    // created script RUNS instead of failing on a missing required field.
    const runnable = ctx.bound.find((b) => allOptional(b.tool.inputSchema));
    const sample = runnable ?? ctx.bound[0];
    const lines: string[] = [];

    lines.push("#!/usr/bin/env bun");
    lines.push("/**");
    lines.push(` * ${ctx.name}${ctx.description ? `: ${ctx.description}` : ""}`);
    lines.push(" *");

    if (ctx.servers.length > 0) {
        lines.push(` * Servers: ${ctx.servers.join(", ")}`);
    }

    lines.push(` * Created from: ${ctx.createdFrom}`);

    if (ctx.project) {
        lines.push(` * Project: ${ctx.project}`);
    }

    if (ctx.tags.length > 0) {
        lines.push(` * Tags: ${ctx.tags.join(", ")}`);
    }

    lines.push(" *");
    lines.push(` * Run:  tools scripts run ${ctx.name}`);

    if (ctx.bound.length > 0) {
        lines.push(` * Edit: this file. Typed tool bindings live in ./${ctx.name}.tools.ts (generated).`);
    }

    lines.push(" * Sidecars (presets, state, output) belong in this directory.");
    lines.push(" */");
    lines.push('import { text, withKit } from "@gt/scripts/kit";');

    if (ctx.bound.length > 0) {
        lines.push(`import * as T from "./${ctx.name}.tools.ts";`);
    }

    lines.push("");
    lines.push("await withKit(async (kit) => {");

    if (ctx.bound.length > 0) {
        lines.push(`    // Bound tools: ${ctx.bound.map((b) => b.fnName).join(", ")}`);
    }

    if (sample && runnable) {
        const empty = isEmptySchema(sample.tool.inputSchema);
        lines.push("");
        lines.push(`    const result = await T.${sample.fnName}(kit${empty ? "" : ", {}"});`);
        lines.push("    console.log(text(result));");
    } else if (sample) {
        // Every bound tool has required arguments, so anything we generate here
        // would throw. Leave a filled-in template commented out instead.
        const argType = schemaToType(sample.tool.inputSchema, 1);
        lines.push("");
        lines.push(`    // Every bound tool needs arguments. ${sample.fnName} expects:`);
        for (const line of argType.split("\n")) {
            lines.push(`    // ${line}`);
        }

        lines.push(`    // const result = await T.${sample.fnName}(kit, { /* ... */ });`);
        lines.push("    // console.log(text(result));");
        lines.push("");
        lines.push(`    console.log("bound:", Object.keys(T.TOOLS).join(", "));`);
    } else {
        lines.push("");
        lines.push("    // No bindings were imported. kit.callRef reaches any enabled server:");
        lines.push('    // const raw = await kit.callRef("genesis-tools.handoff_list", { limit: 3 });');
        lines.push("    console.log(kit.servers());");
    }

    lines.push(`}${ctx.servers.length > 0 ? `, { servers: ${safeJsonArray(ctx.servers)} }` : ""});`);
    lines.push("");
    return lines.join("\n");
}
