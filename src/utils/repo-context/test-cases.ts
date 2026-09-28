import ts from "typescript";
import type { LineRange } from "./types";

const SCRIPT_PATH = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const PYTHON_PATH = /\.pyi?$/;
const TEST_FILE_PATTERNS = [
    /\.(?:test|spec)\.[cm]?[jt]sx?$/,
    /(?:^|\/)test_[^/]*\.py$/,
    /_test\.py$/,
    /_test\.go$/,
    /Test\.php$/,
    /_spec\.rb$/,
    /(?:^|\/)tests\/[^/]+\.rs$/,
];
const TEST_CALLEES = new Set(["test", "it"]);
const PYTHON_TEST = /^\s*(?:async\s+)?def\s+test_/;
/** Parsing a generated bundle to find test calls is waste; the same bound the grep parser uses. */
const MAX_PARSE_BYTES = 1_000_000;

/** Test-file naming conventions for the ecosystems `projects.ts` knows. A name alone proves nothing. */
export function isTestFilePath(path: string): boolean {
    return TEST_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

function testCallee(expression: ts.Expression): boolean {
    if (ts.isIdentifier(expression)) {
        return TEST_CALLEES.has(expression.text);
    }

    // `test.each(rows)(...)`, `test.skip(...)`, `it.only(...)`.
    if (ts.isPropertyAccessExpression(expression)) {
        return testCallee(expression.expression);
    }

    return ts.isCallExpression(expression) ? testCallee(expression.expression) : false;
}

function scriptKind(path: string): ts.ScriptKind {
    if (path.endsWith(".tsx")) {
        return ts.ScriptKind.TSX;
    }

    if (path.endsWith(".jsx")) {
        return ts.ScriptKind.JSX;
    }

    return /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * Line ranges of individual test cases: `test(...)` / `it(...)` calls in TypeScript and JavaScript,
 * `def test_...` lines in Python. Undefined means no locator exists for the language, which is
 * different from "this file has no test cases" (an empty array).
 */
export function locateTestCases(path: string, source: string): LineRange[] | undefined {
    if (Buffer.byteLength(source) > MAX_PARSE_BYTES) {
        return undefined;
    }

    if (PYTHON_PATH.test(path)) {
        return source
            .split("\n")
            .flatMap((line, index) => (PYTHON_TEST.test(line) ? [{ startLine: index + 1, endLine: index + 1 }] : []));
    }

    if (!SCRIPT_PATH.test(path)) {
        return undefined;
    }

    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
    const line = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
    const ranges: LineRange[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && testCallee(node.expression)) {
            const start = node.getStart(file);
            ranges.push({ startLine: line(start), endLine: line(Math.max(start, node.end - 1)) });
            return;
        }

        ts.forEachChild(node, visit);
    };
    visit(file);
    return ranges;
}

export function coveredBy(inner: LineRange, ranges: readonly LineRange[]): boolean {
    return ranges.some((range) => inner.startLine >= range.startLine && inner.endLine <= range.endLine);
}
