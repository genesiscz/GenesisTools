import type { namedTypes as n } from "ast-types";

/**
 * Node-kind type guards for jscodeshift / recast ASTs. Every guard accepts anything, including `null` and
 * `undefined`, and answers `false` instead of throwing: a codemod walks optional fields (`attr.value`,
 * `spec.imported`) constantly, and a throw there aborts the whole file's transform.
 */

function nodeType(node: unknown): unknown {
    if (typeof node !== "object" || node === null || !("type" in node)) {
        return undefined;
    }

    return node.type;
}

function literalValue(node: unknown): unknown {
    if (typeof node !== "object" || node === null || !("value" in node)) {
        return undefined;
    }

    return node.value;
}

// JSX-related type guards
/**
 * JSX expression inside braces in JSX.
 *
 * @example
 * ```jsx
 * <Comp attr={expr} />
 * //            ^^^^^ -> JSXExpressionContainer
 * ```
 * @example
 * ```jsx
 * <Comp>{children}</Comp>
 * //      ^^^^^^^^^ -> JSXExpressionContainer
 * ```
 */
export function isJSXExpressionContainer(node: unknown): node is n.JSXExpressionContainer {
    return nodeType(node) === "JSXExpressionContainer";
}

/**
 * A single JSX attribute key/value pair on an element.
 *
 * @example
 * ```jsx
 * <Comp disabled />
 * //     ^^^^^^^ -> JSXAttribute (boolean)
 * ```
 * @example
 * ```jsx
 * <Comp title="Hello" />
 * //     ^^^^^^^^^^^^^ -> JSXAttribute (string literal)
 * ```
 */
export function isJSXAttribute(node: unknown): node is n.JSXAttribute {
    return nodeType(node) === "JSXAttribute";
}

/**
 * A JSX element, e.g., `<div />` or `<Comp>...</Comp>`.
 *
 * @example
 * ```jsx
 * <Comp />
 * //^^^^^^ -> JSXElement
 * ```
 */
export function isJSXElement(node: unknown): node is n.JSXElement {
    return nodeType(node) === "JSXElement";
}

/**
 * An identifier used in JSX, e.g., the tag or attribute name.
 *
 * @example
 * ```jsx
 * <Comp prop={1} />
 * // ^^^^ -> JSXIdentifier (name of the element)
 * //       ^^^^ -> JSXIdentifier (name of the attribute)
 * ```
 */
export function isJSXIdentifier(node: unknown): node is n.JSXIdentifier {
    return nodeType(node) === "JSXIdentifier";
}

/**
 * The opening part of a JSX element, including its name and attributes.
 *
 * @example
 * ```jsx
 * <Comp a={1}>
 * //^^^^^^^^^ -> JSXOpeningElement
 * </Comp>
 * ```
 */
export function isJSXOpeningElement(node: unknown): node is n.JSXOpeningElement {
    return nodeType(node) === "JSXOpeningElement";
}

/**
 * A spread attribute in JSX.
 *
 * @example
 * ```jsx
 * <Comp {...props} />
 * //      ^^^^^^^^ -> JSXSpreadAttribute ("{...props}")
 * ```
 */
export function isJSXSpreadAttribute(node: unknown): node is n.JSXSpreadAttribute {
    return nodeType(node) === "JSXSpreadAttribute";
}

// Identifier type guards
/**
 * A plain JavaScript identifier (name).
 *
 * @example
 * ```js
 * const foo = 1;
 * //     ^^^ -> Identifier (declarator id)
 * ```
 */
export function isIdentifier(node: unknown): node is n.Identifier {
    return nodeType(node) === "Identifier";
}

// Literal type guards (handling different AST parsers)
/**
 * A primitive literal (string, number, or boolean).
 *
 * @example
 * ```js
 * 42
 * // ^^ -> Literal (number)
 * 'x'
 * // ^^ -> Literal (string)
 * true
 * // ^^^^ -> Literal (boolean)
 * ```
 */
export function isLiteral(node: unknown): node is n.Literal {
    const type = nodeType(node);

    return type === "Literal" || type === "StringLiteral" || type === "NumericLiteral" || type === "BooleanLiteral";
}

/**
 * A string literal.
 *
 * @example
 * ```js
 * 'hello'
 * // ^^^^^^ -> StringLiteral
 * ```
 */
export function isStringLiteral(node: unknown): node is n.StringLiteral | (n.Literal & { value: string }) {
    const type = nodeType(node);

    return type === "StringLiteral" || (type === "Literal" && typeof literalValue(node) === "string");
}

/**
 * A numeric literal.
 *
 * @example
 * ```js
 * 123
 * // ^^^ -> NumericLiteral
 * ```
 */
export function isNumericLiteral(node: unknown): node is n.NumericLiteral | (n.Literal & { value: number }) {
    const type = nodeType(node);

    return type === "NumericLiteral" || (type === "Literal" && typeof literalValue(node) === "number");
}

/**
 * A boolean literal.
 *
 * @example
 * ```js
 * false
 * // ^^^^^ -> BooleanLiteral
 * ```
 */
export function isBooleanLiteral(node: unknown): node is n.BooleanLiteral | (n.Literal & { value: boolean }) {
    const type = nodeType(node);

    return type === "BooleanLiteral" || (type === "Literal" && typeof literalValue(node) === "boolean");
}

// Expression type guards
/**
 * A property access like `obj.prop` or `obj[expr]`.
 *
 * @example
 * ```js
 * obj.prop
 * // ^^^^^^^ -> MemberExpression
 * ```
 */
export function isMemberExpression(node: unknown): node is n.MemberExpression {
    return nodeType(node) === "MemberExpression";
}

/**
 * A function/method call.
 *
 * @example
 * ```js
 * fn(arg)
 * // ^^^^^ -> CallExpression
 * ```
 */
export function isCallExpression(node: unknown): node is n.CallExpression {
    return nodeType(node) === "CallExpression";
}

/**
 * An object literal.
 *
 * @example
 * ```js
 * { a: 1, b: 2 }
 * // ^^^^^^^^^^^ -> ObjectExpression
 * ```
 */
export function isObjectExpression(node: unknown): node is n.ObjectExpression {
    return nodeType(node) === "ObjectExpression";
}

/**
 * A ternary `cond ? a : b` expression.
 *
 * @example
 * ```js
 * isReady ? a : b
 * //^^^^^^^^^^^^^ -> ConditionalExpression
 * ```
 */
export function isConditionalExpression(node: unknown): node is n.ConditionalExpression {
    return nodeType(node) === "ConditionalExpression";
}

/**
 * A template string with optional interpolations.
 *
 * @example
 * ```js
 * const s = `Hello ${name}`;
 * //          ^^^^^^^^^^^^^ -> TemplateLiteral
 * ```
 */
export function isTemplateLiteral(node: unknown): node is n.TemplateLiteral {
    return nodeType(node) === "TemplateLiteral";
}

// Property type guards (handling both Property and ObjectProperty)
/**
 * A key/value pair inside an object literal.
 *
 * @example
 * ```js
 * { a: 1 }
 * //  ^^^ -> Property
 * ```
 */
export function isProperty(node: unknown): node is n.Property | n.ObjectProperty {
    const type = nodeType(node);

    return type === "Property" || type === "ObjectProperty";
}

// Statement type guards
/**
 * A block `{ ... }`, commonly the body of functions, loops, etc.
 *
 * @example
 * ```js
 * function f() { doWork(); }
 * //            ^^^^^^^^^ -> BlockStatement
 * ```
 */
export function isBlockStatement(node: unknown): node is n.BlockStatement {
    return nodeType(node) === "BlockStatement";
}

/**
 * A `var`/`let`/`const` declaration statement.
 *
 * @example
 * ```js
 * const x = 1, y = 2;
 * // ^^^^^^^^^^^^^^^ -> VariableDeclaration
 * ```
 */
export function isVariableDeclaration(node: unknown): node is n.VariableDeclaration {
    return nodeType(node) === "VariableDeclaration";
}

/**
 * One `id = init` entry within a variable declaration.
 *
 * @example
 * ```js
 * const x = 1;
 * //     ^^^ -> VariableDeclarator ("x = 1")
 * ```
 */
export function isVariableDeclarator(node: unknown): node is n.VariableDeclarator {
    return nodeType(node) === "VariableDeclarator";
}

// Function type guards
/**
 * `function() {}` used as an expression.
 *
 * @example
 * ```js
 * const f = function (a) { return a; };
 * //          ^^^^^^^^^^^^^^^^^^^^^^^ -> FunctionExpression
 * ```
 */
export function isFunctionExpression(node: unknown): node is n.FunctionExpression {
    return nodeType(node) === "FunctionExpression";
}

/**
 * An arrow function `(args) => body`.
 *
 * @example
 * ```js
 * const f = (x) => x + 1;
 * //          ^^^^^^^^^^ -> ArrowFunctionExpression
 * ```
 */
export function isArrowFunctionExpression(node: unknown): node is n.ArrowFunctionExpression {
    return nodeType(node) === "ArrowFunctionExpression";
}

/**
 * A `function name() {}` declaration.
 *
 * @example
 * ```js
 * function add(a, b) { return a + b; }
 * //^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ -> FunctionDeclaration
 * ```
 */
export function isFunctionDeclaration(node: unknown): node is n.FunctionDeclaration {
    return nodeType(node) === "FunctionDeclaration";
}

// Import/Export type guards
/**
 * An `import ... from 'module'` statement.
 *
 * @example
 * ```js
 * import { a, b as c } from 'm';
 * // ^^^^^^^^^^^^^^^^^^^^^^^^^ -> ImportDeclaration
 * ```
 */
export function isImportDeclaration(node: unknown): node is n.ImportDeclaration {
    return nodeType(node) === "ImportDeclaration";
}

/**
 * A named import specifier inside an import declaration.
 *
 * @example
 * ```js
 * import { a, b as c } from 'm';
 * //         ^        -> ImportSpecifier ("a")
 * //            ^^^^^ -> ImportSpecifier ("b as c")
 * ```
 */
export function isImportSpecifier(node: unknown): node is n.ImportSpecifier {
    return nodeType(node) === "ImportSpecifier";
}

// TypeScript type guards
/**
 * A TypeScript type annotation following a colon.
 *
 * @example
 * ```ts
 * let x: string;
 * //    ^^^^^^^ -> TSTypeAnnotation (": string")
 * ```
 */
export function isTSTypeAnnotation(node: unknown): node is n.TSTypeAnnotation {
    return nodeType(node) === "TSTypeAnnotation";
}

/**
 * A reference to a named TypeScript type, possibly with type arguments.
 *
 * @example
 * ```ts
 * type T = Array<string>;
 * //         ^^^^^^^^^^^ -> TSTypeReference
 * ```
 */
export function isTSTypeReference(node: unknown): node is n.TSTypeReference {
    return nodeType(node) === "TSTypeReference";
}

// Pattern type guards
/**
 * An object destructuring pattern.
 *
 * @example
 * ```js
 * const { a, b: c } = obj;
 * //      ^^^^^^^^^ -> ObjectPattern
 * ```
 */
export function isObjectPattern(node: unknown): node is n.ObjectPattern {
    return nodeType(node) === "ObjectPattern";
}

// Utility type guard for JSX attribute values
/**
 * A JSX attribute whose value is an expression inside `{}`.
 *
 * @example
 * ```jsx
 * <Comp a={value} />
 * //     ^^^^^^^^ -> JSXAttribute with JSXExpressionContainer value ("{value}")
 * ```
 */
export function hasJSXExpressionValue(
    attr: n.JSXAttribute | null | undefined
): attr is n.JSXAttribute & { value: n.JSXExpressionContainer } {
    // callers reach this straight off `attributes[i]`, which is routinely absent; every sibling guard
    // answers false for an absent node, and throwing here aborts the whole file's transform instead
    return Boolean(attr) && attr?.value != null && isJSXExpressionContainer(attr.value);
}

// Complex type guard for properties with identifier keys
/**
 * An object property whose key is an identifier (not a string/number literal).
 *
 * @example
 * ```js
 * { a: 1, 'b': 2 }
 * //  ^^^ -> Identifier key (passes)
 * //        ^^^^^ -> Literal key (does not pass)
 * ```
 */
export function isPropertyWithIdentifierKey(
    node: unknown
): node is (n.Property | n.ObjectProperty) & { key: n.Identifier } {
    return isProperty(node) && isIdentifier(node.key);
}

// Type guard for optional member expression
/**
 * An optional chaining property access, like `obj?.prop`.
 *
 * @example
 * ```js
 * obj?.prop
 * // ^^^^^^^ -> OptionalMemberExpression
 * ```
 */
export function isOptionalMemberExpression(node: unknown): node is n.OptionalMemberExpression {
    return nodeType(node) === "OptionalMemberExpression";
}
