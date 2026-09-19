#!/usr/bin/env bun

/**
 * Jev instrumentation guard (WP12 of the live-policy consolidation).
 *
 * Every function under `src/jev/**` or `src/utils/ai/stt/**` that reaches an external resource
 * (`callTool(` on the chrome-devtools MCP, `evaluate(` on Jev, `runAx(` on the ax-tool binary,
 * `new WebSocket(` for a live STT socket) must carry a profiler measurement (`prof.*` or
 * `profiler.*`) in the same function, so `PROFILE=jev-*` can show where the time went.
 *
 * "Same function" means the call's nearest enclosing function-like node or any function-like
 * ancestor: a callback inside an instrumented function is covered by its parent. A call at module
 * level is not a function and is skipped. Test files are skipped.
 *
 * A call that genuinely should not carry its own timer is exempted by a comment on the line above
 * or at its end that states why: `// jev-instrumentation-ignore: <reason>`. The reason is required,
 * so an exemption is a decision somebody wrote down rather than a silent bypass. Every other guard
 * in this repo has such a hatch; one without it forces meaningless timers into thin forwarders.
 *
 * Exit 0 clean, exit 1 with one `file:line` per finding. Anything else is a broken scan.
 * `scripts/ci/jev-instrumentation-guard.test.ts` proves the scan catches a planted violation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { Glob } from "bun";

const ROOTS = ["src/jev", "src/utils/ai/stt"];
const TRIGGER_CALLEES = new Set(["callTool", "evaluate", "runAx"]);
const TRIGGER_CONSTRUCTORS = new Set(["WebSocket"]);
const FUNCTION_KINDS = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "generator_function_declaration",
    "generator_function",
]);
const INSTRUMENTED = /\bprof(?:iler)?\./;
const IGNORE = /\/\/\s*jev-instrumentation-ignore:\s*\S+/;

export interface Finding {
    file: string;
    line: number;
    call: string;
    fn: string;
}

function calleeName(text: string): string {
    const withoutTypeArgs = text.replace(/<[^<>]*>$/, "");
    const lastDot = withoutTypeArgs.lastIndexOf(".");
    return lastDot === -1 ? withoutTypeArgs : withoutTypeArgs.slice(lastDot + 1);
}

function enclosingFunctions(node: SgNode): SgNode[] {
    const found: SgNode[] = [];
    let current = node.parent();
    while (current) {
        if (FUNCTION_KINDS.has(String(current.kind()))) {
            found.push(current);
        }

        current = current.parent();
    }

    return found;
}

function functionLabel(fn: SgNode): string {
    const own = fn.field("name");
    if (own) {
        return own.text();
    }

    const parent = fn.parent();
    if (parent?.kind() === "variable_declarator" || parent?.kind() === "pair") {
        const name = parent.field("name") ?? parent.field("key");
        if (name) {
            return name.text();
        }
    }

    return "<anonymous>";
}

export function scanSource(source: string, file: string): Finding[] {
    const root = parse(Lang.TypeScript, source).root();
    const findings: Finding[] = [];
    const lines = source.split("\n");

    /** An exemption sits on the call's own line or on the line above it, and must state a reason. */
    const exempt = (line: number): boolean => IGNORE.test(lines[line] ?? "") || IGNORE.test(lines[line - 1] ?? "");

    const check = (node: SgNode, call: string): void => {
        const line = node.range().start.line;
        if (exempt(line)) {
            return;
        }

        const functions = enclosingFunctions(node);
        if (functions.length === 0) {
            return;
        }

        if (functions.some((fn) => INSTRUMENTED.test(fn.text()))) {
            return;
        }

        findings.push({ file, line: node.range().start.line + 1, call, fn: functionLabel(functions[0]) });
    };

    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
        const callee = call.field("function");
        if (!callee) {
            continue;
        }

        const name = calleeName(callee.text());
        if (TRIGGER_CALLEES.has(name)) {
            check(call, `${name}(`);
        }
    }

    for (const construction of root.findAll({ rule: { kind: "new_expression" } })) {
        const ctor = construction.field("constructor");
        if (ctor && TRIGGER_CONSTRUCTORS.has(ctor.text())) {
            check(construction, `new ${ctor.text()}(`);
        }
    }

    return findings;
}

export function scanRepo(cwd: string): Finding[] {
    const glob = new Glob("**/*.ts");
    const findings: Finding[] = [];
    for (const rootDir of ROOTS) {
        for (const relative of glob.scanSync({ cwd: join(cwd, rootDir) })) {
            if (relative.endsWith(".test.ts") || relative.endsWith(".d.ts")) {
                continue;
            }

            const file = join(rootDir, relative);
            findings.push(...scanSource(readFileSync(join(cwd, file), "utf8"), file));
        }
    }

    return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
    const findings = scanRepo(process.cwd());
    for (const finding of findings) {
        console.error(
            `${finding.file}:${finding.line}: ${finding.call} in ${finding.fn}() has no prof.* measurement in its function`
        );
    }

    console.error(
        findings.length === 0
            ? "[jev-instrumentation-guard] clean"
            : `[jev-instrumentation-guard] ${findings.length} uninstrumented external call(s)`
    );
    process.exit(findings.length === 0 ? 0 : 1);
}
