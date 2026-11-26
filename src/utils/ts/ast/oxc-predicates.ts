import type { Expression, Node } from "oxc-parser";

function isLiteralValue(node: Node | null | undefined, value: string | number): boolean {
    return node?.type === "Literal" && node.value === value;
}

function isZero(expression: Expression): boolean {
    return isLiteralValue(expression, 0);
}

/** Matches the `void 0` spelling of undefined used in minified bundles. */
function isUndefined(expression: Expression): boolean {
    return expression.type === "UnaryExpression" && expression.operator === "void" && isZero(expression.argument);
}

/** Follow the false arms of ternaries whose true arms match the given string literals in order. */
function conditionalTail(initializer: Expression, consequents: readonly string[]): Expression | undefined {
    let expression = initializer;

    for (const value of consequents) {
        if (expression.type !== "ConditionalExpression" || !isLiteralValue(expression.consequent, value)) {
            return undefined;
        }

        expression = expression.alternate;
    }

    return expression;
}

export const ast = { isLiteralValue, isZero, isUndefined, conditionalTail };
