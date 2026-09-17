import { SafeJSON } from "@genesiscz/utils/json";
import type { ExperimentRequest, ProgramState } from "./experiment-contract";

export { experimentRequestSchema as typescriptRequestSchema } from "./experiment-contract";
export type TypeScriptRequest = ExperimentRequest;
export type TypeScriptState = ProgramState;

type Slot = "statement" | "name" | "number" | "index" | "math" | "output" | "output-tail";
const IDENTIFIERS = ["a", "b", "n", "x", "y", "sum", "result"];
const NUMBERS = ["0", "1", "2", "3", "5", "10", "42", "100"];
const INPUT_TOKENS = [
    ":",
    "number",
    "[",
    "]",
    "=",
    "(",
    "await",
    "Bun",
    ".",
    "stdin",
    ".",
    "text",
    "(",
    ")",
    ")",
    ".",
    "trim",
    "(",
    ")",
    ".",
    "split",
    "(",
    "/\\s+/",
    ")",
    ".",
    "map",
    "(",
    "Number",
    ")",
    ";",
];

class TypeScriptGrammar {
    private queue: string[] = ["export", "{", "}", ";"];
    private slot: Slot = "statement";
    private variables: Array<{ name: string; mutable: boolean }> = [];
    private pendingVariable?: string;
    private mutable = false;
    private inputDeclared = false;
    private expressionTerms = 0;
    private outputTerms = 0;
    private statements = 0;
    private finished = false;
    readonly tokens: string[] = [];

    constructor(private literals: string[]) {}
    get complete(): boolean {
        return this.finished;
    }
    get candidates(): string[] {
        if (this.complete) {
            return [];
        }
        if (this.queue.length) {
            return [this.queue[0]];
        }
        const names = this.variables.map((item) => item.name);
        switch (this.slot) {
            case "statement":
                return this.statements >= 20
                    ? ["<done>"]
                    : [
                          "console",
                          ...(names.length < IDENTIFIERS.length || !this.inputDeclared ? ["const", "let"] : []),
                          ...this.variables.filter((item) => item.mutable).map((item) => item.name),
                          ...(this.statements ? ["<done>"] : []),
                      ];
            case "name":
                return [
                    ...IDENTIFIERS.filter((name) => !names.includes(name)),
                    ...(!this.inputDeclared ? ["input"] : []),
                ];
            case "number":
                return [...NUMBERS, ...names, ...(this.inputDeclared ? ["input"] : [])];
            case "index":
                return ["0", "1", "2", "3"];
            case "math":
                return this.expressionTerms >= 3 ? [";"] : ["+", "-", "*", ";"];
            case "output":
                return [...new Set([...this.literals.map((value) => SafeJSON.stringify(value)), ...NUMBERS, ...names])];
            case "output-tail":
                return this.outputTerms >= 6 ? [")"] : [",", ")"];
            default:
                throw new Error("Unknown TypeScript grammar slot.");
        }
    }

    accept(token: string): void {
        if (!this.candidates.includes(token)) {
            throw new Error(`Illegal TypeScript token at step ${this.tokens.length + 1}: ${SafeJSON.stringify(token)}`);
        }

        this.tokens.push(token);
        if (this.queue.length) {
            this.queue.shift();
            return;
        }
        switch (this.slot) {
            case "statement": {
                if (token === "<done>") {
                    this.finished = true;
                    break;
                }
                this.statements++;
                if (token === "console") {
                    this.queue = [".", "log", "("];
                    this.outputTerms = 0;
                    this.slot = "output";
                } else if (token === "const" || token === "let") {
                    this.mutable = token === "let";
                    this.slot = "name";
                } else {
                    this.queue = ["="];
                    this.expressionTerms = 0;
                    this.slot = "number";
                }
                break;
            }
            case "name": {
                if (token === "input") {
                    this.queue = [...INPUT_TOKENS];
                    this.inputDeclared = true;
                    this.slot = "statement";
                } else {
                    this.pendingVariable = token;
                    this.queue = [":", "number", "="];
                    this.expressionTerms = 0;
                    this.slot = "number";
                }
                break;
            }
            case "number": {
                this.expressionTerms++;
                if (token === "input") {
                    this.queue = ["["];
                    this.slot = "index";
                } else {
                    this.slot = "math";
                }
                break;
            }
            case "index": {
                this.queue = ["]"];
                this.slot = "math";
                break;
            }
            case "math": {
                if (token === ";") {
                    if (this.pendingVariable) {
                        this.variables.push({ name: this.pendingVariable, mutable: this.mutable });
                        this.pendingVariable = undefined;
                    }
                    this.slot = "statement";
                } else {
                    this.slot = "number";
                }
                break;
            }
            case "output": {
                this.outputTerms++;
                this.slot = "output-tail";
                break;
            }
            case "output-tail": {
                if (token === ")") {
                    this.queue = [";"];
                    this.slot = "statement";
                } else {
                    this.slot = "output";
                }
                break;
            }
        }
    }

    snapshot(): TypeScriptState {
        return {
            source: renderTypeScript(this.tokens),
            tokens: [...this.tokens],
            candidates: this.candidates,
            slot: this.complete ? "complete" : this.queue.length ? "syntax" : this.slot,
            complete: this.complete,
        };
    }
}

export function renderTypeScript(tokens: string[]): string {
    let source = "";
    for (const token of tokens.filter((item) => item !== "<done>")) {
        if (token === ";") {
            source = `${source.trimEnd()};\n`;
        } else if ([".", "(", ")", "[", "]", "}"].includes(token)) {
            source = source.trimEnd() + token;
        } else if (token === ",") {
            source = `${source.trimEnd()}, `;
        } else if (token === ":") {
            source = `${source.trimEnd()}: `;
        } else if (["=", "+", "-", "*", "{"].includes(token)) {
            source = `${source.trimEnd()} ${token} `;
        } else {
            const separator = source && !/[\s.([]$/.test(source) ? " " : "";
            source += separator + token;
        }
    }

    return source.trimEnd();
}

export function typescriptState(request: Pick<TypeScriptRequest, "literals" | "tokens">): TypeScriptState {
    const grammar = new TypeScriptGrammar(request.literals);
    for (const token of request.tokens) {
        grammar.accept(token);
    }
    return grammar.snapshot();
}

export const typescriptPresets = [
    {
        name: "Hello world",
        goal: "Write a TypeScript program that prints Hello, World! followed by one newline.",
        literals: ["Hello, World!"],
        stdin: "",
    },
    {
        name: "Add two numbers",
        goal: "Declare input as the parsed numbers from stdin. Declare a as input[0] and b as input[1]. Compute their sum, then print it.",
        literals: [],
        stdin: "12 30\n",
    },
    {
        name: "Arithmetic",
        goal: "Declare a numeric constant result equal to 10 * 10 and print result.",
        literals: [],
        stdin: "",
    },
];
