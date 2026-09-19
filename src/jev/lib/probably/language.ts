import { SafeJSON } from "@genesiscz/utils/json";

/** Probably 0.1: a deliberately small grammar. No eval, JS access, imports or tools. */

export type Value = string | number | boolean;

type Token = { text: string; kind: "word" | "string" | "number" | "symbol" | "end"; line: number };

export type Expr =
    | { kind: "literal"; value: Value }
    | { kind: "variable"; name: string }
    | { kind: "input" }
    | { kind: "write"; prompt: string; using?: Expr };

type Base = { line: number };

export type Statement = Base &
    (
        | { kind: "let" | "set"; name: string; value: Expr }
        | { kind: "print"; value: Expr }
        | {
              kind: "if";
              value: Expr;
              question: string;
              confidence: number;
              yes: Statement[];
              maybe: Statement[];
              no: Statement[];
          }
        | { kind: "match"; value: Expr; branches: Array<{ label: string; body: Statement[] }> }
        | { kind: "while"; value: Expr; question: string; body: Statement[] }
        | { kind: "repeat"; count: number; body: Statement[] }
        | { kind: "chaos"; body: Statement[] }
    );

export class LanguageError extends Error {
    constructor(
        message: string,
        public line: number
    ) {
        super(`Line ${line}: ${message}`);
    }
}

function lex(source: string): Token[] {
    if (source.length > 12000) {
        throw new LanguageError("Program exceeds 12,000 characters.", 1);
    }

    const tokens: Token[] = [];
    let i = 0;
    let line = 1;

    while (i < source.length) {
        const c = source[i];

        if (/\s/.test(c)) {
            if (c === "\n") {
                line++;
            }

            i++;
            continue;
        }

        if (source.startsWith("//", i)) {
            while (i < source.length && source[i] !== "\n") {
                i++;
            }

            continue;
        }

        const startLine = line;

        if (c === '"') {
            const start = i++;

            while (i < source.length && source[i] !== '"') {
                if (source[i] === "\n") {
                    throw new LanguageError("Use \\n inside strings.", startLine);
                }

                if (source[i] === "\\") {
                    i++;
                }

                i++;
            }

            if (i >= source.length) {
                throw new LanguageError("Unterminated string.", startLine);
            }

            let value: string;

            try {
                value = SafeJSON.parse(source.slice(start, ++i), { strict: true }) as string;
            } catch {
                throw new LanguageError("Invalid string escape.", startLine);
            }

            tokens.push({ text: value, kind: "string", line });
            continue;
        }

        const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));

        if (word) {
            tokens.push({ text: word[0], kind: "word", line });
            i += word[0].length;
            continue;
        }

        const number = /^\d+(?:\.\d+)?/.exec(source.slice(i));

        if (number) {
            tokens.push({ text: number[0], kind: "number", line });
            i += number[0].length;
            continue;
        }

        if (source.startsWith("=>", i)) {
            tokens.push({ text: "=>", kind: "symbol", line });
            i += 2;
            continue;
        }

        if ("{}()=%;".includes(c)) {
            tokens.push({ text: c, kind: "symbol", line });
            i++;
            continue;
        }

        throw new LanguageError(`Unexpected character ${SafeJSON.stringify(c)}.`, line);
    }

    return [...tokens, { text: "<end>", kind: "end", line }];
}

const reserved = new Set([
    "let",
    "print",
    "if",
    "feels",
    "with",
    "confidence",
    "otherwise",
    "maybe",
    "else",
    "match",
    "repeat",
    "while",
    "chaos",
    "llm",
    "write",
    "using",
    "input",
    "true",
    "false",
]);

export function parse(source: string): Statement[] {
    const tokens = lex(source);
    let i = 0;
    let depth = 0;

    const peek = () => tokens[i];
    const is = (s: string) => peek().text === s && peek().kind !== "string";
    const take = () => tokens[i++];
    const accept = (s: string) => {
        if (!is(s)) {
            return false;
        }

        take();
        return true;
    };
    const need = (s: string) => {
        if (!accept(s)) {
            throw new LanguageError(`Expected ${s}, got ${peek().text}.`, peek().line);
        }
    };
    const str = () => {
        const t = take();

        if (t.kind !== "string") {
            throw new LanguageError("Expected a quoted string.", t.line);
        }

        return t.text;
    };
    const name = () => {
        const t = take();

        if (t.kind !== "word" || reserved.has(t.text)) {
            throw new LanguageError("Expected a variable name.", t.line);
        }

        return t.text;
    };
    const expr = (): Expr => {
        const t = peek();

        if (t.kind === "string") {
            take();
            return { kind: "literal", value: t.text };
        }

        if (t.kind === "number") {
            take();
            return { kind: "literal", value: Number(t.text) };
        }

        if (accept("true")) {
            return { kind: "literal", value: true };
        }

        if (accept("false")) {
            return { kind: "literal", value: false };
        }

        if (accept("input")) {
            need("(");
            need(")");
            return { kind: "input" };
        }

        if (accept("llm") || accept("write")) {
            const prompt = str();
            return { kind: "write", prompt, ...(accept("using") ? { using: atom() } : {}) };
        }

        return { kind: "variable", name: name() };
    };
    const atom = (): Expr => {
        if (is("llm") || is("write")) {
            throw new LanguageError("Assign generated text before using it.", peek().line);
        }

        return expr();
    };
    const block = (): Statement[] => {
        need("{");

        if (++depth > 12) {
            throw new LanguageError("Nesting exceeds 12 blocks.", peek().line);
        }

        const body = statements();
        need("}");
        depth--;
        return body;
    };
    const statements = (): Statement[] => {
        const out: Statement[] = [];

        while (peek().kind !== "end" && !is("}")) {
            if (accept(";")) {
                continue;
            }

            const line = peek().line;

            if (accept("let")) {
                const n = name();
                need("=");
                out.push({ kind: "let", line, name: n, value: expr() });
            } else if (accept("print")) {
                need("(");
                const value = expr();
                need(")");
                out.push({ kind: "print", line, value });
            } else if (accept("if")) {
                const value = atom();
                need("feels");
                const question = str();
                let confidence = 0.5;

                if (accept("with")) {
                    need("confidence");
                    const t = take();
                    confidence = Number(t.text) / 100;

                    if (t.kind !== "number" || confidence < 0.5 || confidence > 1) {
                        throw new LanguageError("Confidence must be 50–100%.", t.line);
                    }

                    need("%");
                }

                const yes = block();
                let maybe: Statement[] = [];
                let no: Statement[] = [];

                if (accept("otherwise")) {
                    need("maybe");
                    maybe = block();
                }

                if (accept("else")) {
                    no = block();
                }

                out.push({ kind: "if", line, value, question, confidence, yes, maybe, no });
            } else if (accept("match")) {
                const value = atom();
                need("{");
                const branches: Array<{ label: string; body: Statement[] }> = [];

                while (!is("}") && peek().kind !== "end") {
                    const label = str();
                    need("=>");
                    branches.push({ label, body: block() });
                }

                need("}");

                if (
                    branches.length < 2 ||
                    branches.length > 8 ||
                    new Set(branches.map((b) => b.label)).size !== branches.length
                ) {
                    throw new LanguageError("Match needs 2–8 distinct labels.", line);
                }

                out.push({ kind: "match", line, value, branches });
            } else if (accept("while")) {
                const value = atom();
                need("feels");
                const question = str();
                out.push({ kind: "while", line, value, question, body: block() });
            } else if (accept("repeat")) {
                const t = take();
                const count = Number(t.text);

                if (t.kind !== "number" || !Number.isInteger(count) || count < 1 || count > 5) {
                    throw new LanguageError("Repeat needs an integer from 1 to 5.", t.line);
                }

                out.push({ kind: "repeat", line, count, body: block() });
            } else if (accept("chaos")) {
                out.push({ kind: "chaos", line, body: block() });
            } else {
                const n = name();
                need("=");
                out.push({ kind: "set", line, name: n, value: expr() });
            }
        }

        return out;
    };

    const body = statements();

    if (peek().kind !== "end") {
        throw new LanguageError("Unexpected closing brace.", peek().line);
    }

    return body;
}
