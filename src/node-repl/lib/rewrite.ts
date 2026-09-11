import { parseSync } from "oxc-parser";

/**
 * Turns one REPL turn into a script whose top-level bindings survive the next turn.
 *
 * The turn runs inside an async IIFE so `await` works at the top level. Inside a function
 * body `let`, `const`, `class` and `function` are all local and vanish when it returns, so
 * each of those becomes an assignment onto the shared global: a bare assignment for
 * variables, `globalThis.Name = class Name {}` and `globalThis.name = function name() {}` for
 * the others. Redeclaring then just overwrites the property, which is what a REPL means by it.
 * The last expression statement is returned so its value is the turn's result.
 */

interface Edit {
    start: number;
    end: number;
    text: string;
}

interface Node {
    type: string;
    start: number;
    end: number;
    kind?: string;
    id?: { name: string } | null;
    expression?: { start: number; end: number };
    declarations?: Array<{ start: number; id: { type: string } }>;
}

// Dead-code elimination stays off: the transpiler would drop a side-effect-free last
// expression such as `typeof marker`, and that expression is the turn's result.
function stripTypes(source: string): string {
    return new Bun.Transpiler({ loader: "ts", target: "bun", deadCodeElimination: false }).transformSync(source);
}

export function rewriteTurn(source: string): string {
    const code = stripTypes(source);
    const program = parseSync("repl-turn.js", code, { sourceType: "module" }).program as { body: Node[] };
    const edits: Edit[] = [];
    const body = program.body;

    body.forEach((node, index) => {
        const isLast = index === body.length - 1;

        if (node.type === "VariableDeclaration" && node.kind && node.declarations) {
            const destructuring = node.declarations.some(
                (d) => d.id.type === "ObjectPattern" || d.id.type === "ArrayPattern"
            );
            const keywordEnd = node.declarations[0]?.start ?? node.start + node.kind.length;
            edits.push({ start: node.start, end: keywordEnd, text: destructuring ? "(" : "" });

            if (destructuring) {
                const end = code[node.end - 1] === ";" ? node.end - 1 : node.end;
                edits.push({ start: end, end, text: ")" });
            }
        } else if (node.type === "ClassDeclaration" && node.id) {
            edits.push({
                start: node.start,
                end: node.start + "class".length,
                text: `globalThis.${node.id.name} = class`,
            });
            edits.push({ start: node.end, end: node.end, text: ";" });
        } else if (node.type === "FunctionDeclaration" && node.id) {
            const asyncPrefix = code.slice(node.start, node.start + "async".length) === "async" ? "async " : "";
            const keywordStart = node.start + asyncPrefix.length;
            edits.push({
                start: node.start,
                end: keywordStart + "function".length,
                text: `globalThis.${node.id.name} = ${asyncPrefix}function`,
            });
            edits.push({ start: node.end, end: node.end, text: ";" });
        }

        if (isLast && node.type === "ExpressionStatement" && node.expression) {
            edits.push({ start: node.start, end: node.expression.start, text: "return (" });
            const end = code[node.end - 1] === ";" ? node.end - 1 : node.end;
            edits.push({ start: end, end, text: ")" });
        }
    });

    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = code;
    for (const edit of edits) {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }

    return `(async () => {\n${out}\n})()`;
}
