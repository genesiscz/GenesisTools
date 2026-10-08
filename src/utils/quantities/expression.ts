import {
    defaultUnits,
    dimensionless,
    divideUnits,
    finiteValue,
    multiplyUnits,
    parseUnit,
    powerUnit,
    QuantityError,
    requireSameDimension,
    type Unit,
} from "./units";

export type Expression =
    | { kind: "literal"; value: number; unit: Unit }
    | { kind: "reference"; name: string }
    | { kind: "negate"; value: Expression }
    | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "^"; left: Expression; right: Expression }
    | { kind: "call"; name: "min" | "max" | "abs" | "clamp"; args: Expression[] }
    | { kind: "lag"; name: string; steps: number };

interface Token {
    text: string;
    offset: number;
}

export interface ExpressionContext {
    reference: (name: string) => number;
    lag: (name: string, steps: number) => number;
}

function parseExpressionSource({
    source,
    units = defaultUnits(),
    references,
}: {
    source: string;
    units?: ReadonlyMap<string, Unit>;
    references?: Token[];
}): Expression {
    if (source.length > 4096) {
        throw new QuantityError("A formula cannot exceed 4096 characters.");
    }

    const tokens: Token[] = [];
    const pattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\S/g;
    for (const match of source.matchAll(pattern)) {
        if (!/^\s+$/.test(match[0])) {
            tokens.push({ text: match[0], offset: match.index });
        }
    }

    if (tokens.length > 512) {
        throw new QuantityError("A formula cannot exceed 512 tokens.");
    }

    let cursor = 0;
    const peek = () => tokens[cursor]?.text;
    const fail: (message: string) => never = (message) => {
        throw new QuantityError(`${message} At character ${(tokens[cursor]?.offset ?? source.length) + 1}.`);
    };
    const expect = (text: string) => {
        if (peek() !== text) {
            fail(`Expected “${text}”.`);
        }

        cursor++;
    };
    const parse = (minimum: number, depth: number): Expression => {
        if (depth > 64) {
            fail("The formula is nested too deeply.");
        }

        const token = peek();
        let left: Expression;
        cursor++;

        if (token === "-" || token === "+") {
            const value = parse(3, depth + 1);
            left = token === "-" ? { kind: "negate", value } : value;
        } else if (token === "(") {
            left = parse(0, depth + 1);
            expect(")");
        } else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
            let unit = dimensionless();

            if (peek() === "[") {
                cursor++;
                const parts: string[] = [];
                while (peek() && peek() !== "]") {
                    parts.push(tokens[cursor++].text);
                }

                expect("]");
                unit = parseUnit({ source: parts.join(""), registry: units });
            }

            left = { kind: "literal", value: finiteValue(Number(token)), unit };
        } else if (token && /^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) {
            if (peek() !== "(") {
                references?.push(tokens[cursor - 1]);
                left = { kind: "reference", name: token };
            } else {
                cursor++;
                const args: Expression[] = [];

                if (peek() !== ")") {
                    args.push(parse(0, depth + 1));
                    while (peek() === ",") {
                        cursor++;
                        args.push(parse(0, depth + 1));
                    }
                }

                expect(")");

                if (token === "lag") {
                    const [reference, steps] = args;

                    if (
                        args.length !== 2 ||
                        reference?.kind !== "reference" ||
                        steps?.kind !== "literal" ||
                        steps.unit.dimensions.size !== 0 ||
                        steps.unit.scale !== 1 ||
                        !Number.isInteger(steps.value) ||
                        steps.value < 1 ||
                        steps.value > 10000
                    ) {
                        fail("Use lag(quantity, steps) with a whole step count from 1 to 10000.");
                    }

                    left = { kind: "lag", name: reference.name, steps: steps.value };
                } else if (token === "min" || token === "max" || token === "abs" || token === "clamp") {
                    const valid =
                        token === "abs" ? args.length === 1 : token === "clamp" ? args.length === 3 : args.length >= 2;

                    if (!valid) {
                        fail(`Incorrect number of arguments for ${token}.`);
                    }

                    left = { kind: "call", name: token, args };
                } else {
                    fail(`Unknown function “${token}”. Supported functions: min, max, abs, clamp, lag.`);
                }
            }
        } else {
            fail("Expected a number, quantity, or parenthesized formula.");
        }

        while (true) {
            const operator = peek();

            if (operator !== "+" && operator !== "-" && operator !== "*" && operator !== "/" && operator !== "^") {
                break;
            }

            const precedence = operator === "^" ? 3 : operator === "*" || operator === "/" ? 2 : 1;

            if (precedence < minimum) {
                break;
            }

            cursor++;
            const right = parse(operator === "^" ? precedence : precedence + 1, depth + 1);
            left = { kind: "binary", operator, left, right };
        }

        return left;
    };
    const expression = parse(0, 0);

    if (cursor !== tokens.length) {
        fail(`Unexpected token “${peek()}”.`);
    }

    return expression;
}

export function parseExpression(options: { source: string; units?: ReadonlyMap<string, Unit> }): Expression {
    return parseExpressionSource(options);
}

export function rewriteExpressionReferences({
    source,
    mapping,
}: {
    source: string;
    mapping: ReadonlyMap<string, string>;
}): string {
    const reserved = new Set([
        "time",
        "step",
        "min",
        "max",
        "abs",
        "clamp",
        "lag",
        "__proto__",
        "constructor",
        "prototype",
    ]);
    for (const [before, after] of mapping) {
        if (reserved.has(before) || reserved.has(after) || !/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(after)) {
            throw new QuantityError(
                "Reference rewrites require ordinary quantity identifiers, never clock or function names."
            );
        }
    }

    const references: Token[] = [];
    parseExpressionSource({ source, references });
    let rewritten = source;
    for (const token of references.reverse()) {
        const replacement = mapping.get(token.text);

        if (replacement !== undefined) {
            rewritten =
                rewritten.slice(0, token.offset) + replacement + rewritten.slice(token.offset + token.text.length);
        }
    }

    parseExpression({ source: rewritten });
    return rewritten;
}

export function expressionReferences(expression: Expression): { immediate: Set<string>; delayed: Set<string> } {
    const immediate = new Set<string>();
    const delayed = new Set<string>();
    const visit = (node: Expression) => {
        switch (node.kind) {
            case "reference":
                immediate.add(node.name);
                break;
            case "lag":
                delayed.add(node.name);
                break;
            case "negate":
                visit(node.value);
                break;
            case "binary":
                visit(node.left);
                visit(node.right);
                break;
            case "call":
                node.args.forEach(visit);
                break;
        }
    };
    visit(expression);
    return { immediate, delayed };
}

function literalExponent(expression: Expression): number {
    const value = expression.kind === "negate" ? expression.value : expression;

    if (value.kind !== "literal" || value.unit.dimensions.size !== 0 || value.unit.scale !== 1) {
        throw new QuantityError("An exponent must be a literal integer between -16 and 16.");
    }

    const exponent = expression.kind === "negate" ? -value.value : value.value;
    powerUnit(dimensionless(), exponent);
    return exponent;
}

export function expressionUnit(expression: Expression, referenceUnit: (name: string) => Unit): Unit {
    switch (expression.kind) {
        case "literal":
            return expression.unit;
        case "reference":
        case "lag":
            return referenceUnit(expression.name);
        case "negate":
            return expressionUnit(expression.value, referenceUnit);
        case "call": {
            const first = expressionUnit(expression.args[0], referenceUnit);
            for (const arg of expression.args.slice(1)) {
                requireSameDimension(first, expressionUnit(arg, referenceUnit));
            }
            return first;
        }
        case "binary": {
            const left = expressionUnit(expression.left, referenceUnit);
            const right = expressionUnit(expression.right, referenceUnit);

            switch (expression.operator) {
                case "+":
                case "-":
                    requireSameDimension(left, right);
                    return left;
                case "*":
                    return multiplyUnits(left, right);
                case "/":
                    return divideUnits(left, right);
                case "^":
                    return powerUnit(left, literalExponent(expression.right));
            }
        }
    }
}

/** Values, references and returned results use canonical base units, never display units. */
export function evaluateExpression(expression: Expression, context: ExpressionContext): number {
    const evaluate = (node: Expression): number => {
        switch (node.kind) {
            case "literal":
                return finiteValue(node.value * node.unit.scale);
            case "reference":
                return finiteValue(context.reference(node.name));
            case "lag":
                return finiteValue(context.lag(node.name, node.steps));
            case "negate":
                return -evaluate(node.value);
            case "call": {
                const args = node.args.map(evaluate);

                if (node.name === "abs") {
                    return Math.abs(args[0]);
                }

                if (node.name === "min") {
                    return Math.min(...args);
                }

                if (node.name === "max") {
                    return Math.max(...args);
                }

                if (args[1] > args[2]) {
                    throw new QuantityError("clamp requires a lower limit no greater than its upper limit.");
                }

                return Math.max(args[1], Math.min(args[2], args[0]));
            }
            case "binary": {
                const left = evaluate(node.left);
                const right = evaluate(node.right);
                let result: number;

                switch (node.operator) {
                    case "+":
                        result = left + right;
                        break;
                    case "-":
                        result = left - right;
                        break;
                    case "*":
                        result = left * right;
                        break;
                    case "/":
                        result = left / right;
                        break;
                    case "^":
                        result = left ** literalExponent(node.right);
                        break;
                }

                return finiteValue(result);
            }
        }
    };
    return evaluate(expression);
}
