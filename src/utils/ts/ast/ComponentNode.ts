import { SafeJSON } from "@genesiscz/utils/json";
import type { ExpressionKind } from "ast-types/lib/gen/kinds";
import type { ASTPath, JSCodeshift, JSXAttribute, JSXElement, JSXOpeningElement, ObjectExpression } from "jscodeshift";
import { isJSXElement } from "./guards";
import type { TransformContext } from "./types";

export type ComponentNodeKind = "JSX" | "Identifier" | "Import" | "Type" | "Enum" | "Other";

type ObjectMember = ObjectExpression["properties"][number];

interface EnumValueWithImport {
    type: "enum";
    value: string;
    namedImport: string;
    namedImportFrom: string;
}

function isEnumValueWithImport(value: unknown): value is EnumValueWithImport {
    return (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "enum" &&
        "value" in value &&
        typeof value.value === "string" &&
        "namedImport" in value &&
        typeof value.namedImport === "string" &&
        value.namedImport !== "" &&
        "namedImportFrom" in value &&
        typeof value.namedImportFrom === "string" &&
        value.namedImportFrom !== ""
    );
}

/** An object member's key as written: an identifier's name or a literal key's value. */
function memberKeyOf(member: ObjectMember): unknown {
    if (!("key" in member)) {
        return undefined;
    }

    const key = member.key;
    if ("name" in key && key.name) {
        return key.name;
    }

    return "value" in key ? key.value : undefined;
}

function findNamedAttribute(opening: JSXOpeningElement, name: string): JSXAttribute | undefined {
    return (opening.attributes || []).find(
        (a): a is JSXAttribute => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name
    );
}

/** The expression an attribute value contributes to an object literal: `{expr}` unwraps, `"text"` stays a literal. */
function attributeExpression(j: JSCodeshift, value: JSXAttribute["value"]): ExpressionKind {
    if (!value) {
        return j.literal(true);
    }

    if (value.type === "JSXExpressionContainer") {
        return value.expression.type === "JSXEmptyExpression" ? j.literal(true) : value.expression;
    }

    return value;
}

/**
 * One node a component rule acts on. JSX-only operations (props, children, rename) on a non-JSX node log a
 * warning through the context logger and do nothing.
 */
export class ComponentNode {
    constructor(
        private ctx: TransformContext,
        private element: JSXElement | null,
        public kind: ComponentNodeKind,
        private pathRef?: ASTPath,
        private fromModule?: string
    ) {}

    getJSX(): JSXElement | null {
        return this.element;
    }

    getName(): string | undefined {
        const el = this.element;
        if (!el) {
            return undefined;
        }

        const opening = el.openingElement;
        if (opening.name.type === "JSXIdentifier") {
            return opening.name.name;
        }

        return undefined;
    }

    isNamed(name: string): boolean {
        return this.getName() === name;
    }

    isOneOf(names: string[]): boolean {
        const n = this.getName();
        return !!n && names.includes(n);
    }

    getImportModule(): string | undefined {
        return this.fromModule;
    }

    isImportedFrom(module: string): boolean {
        return this.fromModule === module;
    }

    isImportedFromAny(modules: string[]): boolean {
        if (!this.fromModule) {
            return false;
        }

        return modules.includes(this.fromModule);
    }

    private withJSX(op: (el: JSXElement) => void): void {
        if (!this.element) {
            this.ctx.logger.warning(this.ctx.filePath, "Tried to call JSX-only op on non-JSX node");
            return;
        }

        op(this.element);
    }

    /** Renames the element through the import manager, which also fixes the imports, and remembers the new module. */
    renameTo(to: { name: string; module: string }): void {
        this.withJSX((el) => {
            const originalName = this.getName() || "";
            const originalModule = this.getImportModule() || "";

            const from = { name: originalName, module: originalModule };
            this.ctx.logger.debug("Component.renameTo", SafeJSON.stringify({ from, to }, { strict: true }));
            const result = this.ctx.importManager.resolveComponentRename({ from, to });

            const nameToUse = result.useName;
            if (el.openingElement.name.type === "JSXIdentifier") {
                el.openingElement.name.name = nameToUse;
            }

            if (el.closingElement && el.closingElement.name.type === "JSXIdentifier") {
                el.closingElement.name.name = nameToUse;
            }

            this.fromModule = to.module;
            this.ctx.logger.componentRename(this.ctx.filePath, originalName, nameToUse);
        });
    }

    getProps(): Array<{ name: string; index: number }> {
        const result: Array<{ name: string; index: number }> = [];
        if (!this.element) {
            return result;
        }

        const attrs = this.element.openingElement.attributes || [];
        attrs.forEach((a, i) => {
            if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier") {
                result.push({ name: a.name.name, index: i });
            }
        });
        return result;
    }

    hasProp(name: string): boolean {
        return this.getProps().some((p) => p.name === name);
    }

    /** A literal prop value; `true` for a bare prop; `undefined` for a missing prop or any non-literal expression. */
    getPropValue(name: string): unknown {
        if (!this.element) {
            return undefined;
        }

        const attr = findNamedAttribute(this.element.openingElement, name);
        if (!attr) {
            return undefined;
        }

        if (!attr.value) {
            return true;
        }

        if (attr.value.type === "Literal" || attr.value.type === "StringLiteral") {
            return attr.value.value;
        }

        if (attr.value.type === "JSXExpressionContainer") {
            const expr = attr.value.expression;
            if (
                expr.type === "Literal" ||
                expr.type === "StringLiteral" ||
                expr.type === "NumericLiteral" ||
                expr.type === "BooleanLiteral"
            ) {
                return expr.value;
            }
        }

        return undefined;
    }

    renameProp(from: string, to: string): void {
        this.withJSX((el) => {
            for (const a of el.openingElement.attributes || []) {
                if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === from) {
                    a.name.name = to;
                    this.ctx.logger.propChange(this.ctx.filePath, this.getName() || "", from, "renamed", to);
                }
            }
        });
    }

    /**
     * Sets a prop, replacing it in place when present. A string becomes `name="value"`, a number or boolean
     * `name={value}`, and an enum value with `namedImport` + `namedImportFrom` becomes `name={Enum.MEMBER}`
     * plus the import. Any other value leaves a bare `name` prop.
     */
    setProp(name: string, value: unknown): void {
        this.withJSX((el) => {
            const j = this.ctx.j;
            const opening = el.openingElement;
            const existing = findNamedAttribute(opening, name);

            let newValueNode: JSXAttribute["value"] = null;
            if (typeof value === "string") {
                newValueNode = j.literal(value);
            } else if (typeof value === "number" || typeof value === "boolean") {
                newValueNode = j.jsxExpressionContainer(j.literal(value));
            } else if (isEnumValueWithImport(value)) {
                this.ctx.importManager.ensureImport(value.namedImportFrom, value.namedImport);
                newValueNode = j.jsxExpressionContainer(
                    j.memberExpression(j.identifier(value.namedImport), j.identifier(value.value))
                );
            }

            const attr = j.jsxAttribute(j.jsxIdentifier(name), newValueNode);
            if (!opening.attributes) {
                opening.attributes = [];
            }

            if (existing) {
                const idx = opening.attributes.indexOf(existing);
                opening.attributes.splice(idx, 1, attr);
            } else {
                opening.attributes.push(attr);
            }

            this.ctx.logger.propChange(
                this.ctx.filePath,
                this.getName() || "",
                name,
                existing ? "updated" : "added",
                value
            );
        });
    }

    addPropIfMissing(name: string, value: unknown): void {
        if (this.hasProp(name)) {
            return;
        }

        this.setProp(name, value);
    }

    removeProp(name: string): void {
        this.withJSX((el) => {
            const opening = el.openingElement;
            const before = (opening.attributes || []).length;
            opening.attributes = (opening.attributes || []).filter(
                (a) => !(a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name)
            );

            if ((opening.attributes || []).length !== before) {
                this.ctx.logger.propChange(this.ctx.filePath, this.getName() || "", name, "removed");
            }
        });
    }

    /** Drops every child and turns the element self-closing. */
    removeChildren(): void {
        this.withJSX((el) => {
            if (el.children && el.children.length > 0) {
                el.children = [];
                el.openingElement.selfClosing = true;
                el.closingElement = null;
                this.ctx.logger.propChange(this.ctx.filePath, this.getName() || "", "children", "removed");
            }
        });
    }

    /** Removes `nestedKey` from an object-literal prop: `propName={{ nestedKey: ... }}`. */
    removeNestedProp(propName: string, nestedKey: string): void {
        this.withJSX((el) => {
            const attr = findNamedAttribute(el.openingElement, propName);
            if (attr?.value?.type !== "JSXExpressionContainer") {
                return;
            }

            const expr = attr.value.expression;
            if (expr.type !== "ObjectExpression") {
                return;
            }

            const before = expr.properties.length;
            expr.properties = expr.properties.filter((p) => memberKeyOf(p) !== nestedKey);

            if (expr.properties.length !== before) {
                this.ctx.logger.propChange(
                    this.ctx.filePath,
                    this.getName() || "",
                    `${propName}.${nestedKey}`,
                    "removed"
                );
            }
        });
    }

    /**
     * Renames `fromKey` inside an object-literal prop. Only an identifier key or an estree `Literal` key is
     * rewritten; a `StringLiteral` key (the babel/tsx spelling) matches and is logged but keeps its old name.
     */
    renameNestedProp(propName: string, fromKey: string, toKey: string): void {
        this.withJSX((el) => {
            const attr = findNamedAttribute(el.openingElement, propName);
            if (attr?.value?.type !== "JSXExpressionContainer") {
                return;
            }

            const expr = attr.value.expression;
            if (expr.type !== "ObjectExpression") {
                return;
            }

            for (const p of expr.properties) {
                if (memberKeyOf(p) !== fromKey || !("key" in p)) {
                    continue;
                }

                if (p.key.type === "Identifier") {
                    p.key.name = toKey;
                }

                if (p.key.type === "Literal") {
                    p.key.value = toKey;
                }

                this.ctx.logger.propChange(
                    this.ctx.filePath,
                    this.getName() || "",
                    `${propName}.${fromKey}`,
                    "renamed",
                    toKey
                );
            }
        });
    }

    ensureBooleanProp(name: string): void {
        this.addPropIfMissing(name, true);
    }

    /**
     * Moves prop `name` into the object-literal prop `targetProp` as key `nestedProp`. A missing target is created;
     * an existing key is not overwritten; a target that is not an object literal is replaced by one.
     */
    movePropToNested(name: string, targetProp: string, nestedProp: string): void {
        this.withJSX((el) => {
            const j = this.ctx.j;
            const opening = el.openingElement;

            const srcAttr = findNamedAttribute(opening, name);
            if (!srcAttr) {
                return;
            }

            opening.attributes = (opening.attributes || []).filter((a) => a !== srcAttr);

            const movedValue = attributeExpression(j, srcAttr.value);
            const targetAttr = findNamedAttribute(opening, targetProp);

            if (!targetAttr) {
                const obj = j.objectExpression([j.property("init", j.identifier(nestedProp), movedValue)]);
                opening.attributes = opening.attributes || [];
                opening.attributes.push(j.jsxAttribute(j.jsxIdentifier(targetProp), j.jsxExpressionContainer(obj)));
            } else if (
                targetAttr.value &&
                targetAttr.value.type === "JSXExpressionContainer" &&
                targetAttr.value.expression.type === "ObjectExpression"
            ) {
                const obj = targetAttr.value.expression;
                const exists = obj.properties.some(
                    (p) =>
                        (p.type === "Property" || p.type === "ObjectProperty") &&
                        p.key.type === "Identifier" &&
                        p.key.name === nestedProp
                );

                if (!exists) {
                    obj.properties.push(j.property("init", j.identifier(nestedProp), movedValue));
                }
            } else {
                // the existing value is not an object literal: replace it, keeping only the moved key
                targetAttr.value = j.jsxExpressionContainer(
                    j.objectExpression([j.property("init", j.identifier(nestedProp), movedValue)])
                );
            }

            this.ctx.logger.propChange(
                this.ctx.filePath,
                this.getName() || "",
                name,
                "moved",
                `${targetProp}.${nestedProp}`
            );
        });
    }

    /** Not implemented: a no-op. */
    extractPropToChildren(): void {}

    /**
     * Inserts `<component {...props} />` as the next sibling of this element. Needs the element's path, and a
     * JSX parent with children; otherwise does nothing. String, number and boolean props become literal
     * values, anything else a bare prop.
     */
    appendAfter(op: {
        component: string;
        props?: Record<string, unknown>;
        importPath?: string;
        onlyIf?: (el: JSXElement) => boolean;
        onlyIfUnique?: boolean;
    }): void {
        this.withJSX((el) => {
            const j = this.ctx.j;
            if (op.onlyIf && !op.onlyIf(el)) {
                return;
            }

            const parent: unknown = this.pathRef?.parent?.value;
            if (
                typeof parent !== "object" ||
                parent === null ||
                !("type" in parent) ||
                (parent.type !== "JSXElement" && parent.type !== "JSXFragment") ||
                !("children" in parent) ||
                !Array.isArray(parent.children)
            ) {
                return;
            }

            const children: unknown[] = parent.children;
            const idx = children.indexOf(el);
            if (idx < 0) {
                return;
            }

            if (op.onlyIfUnique && idx + 1 < children.length) {
                const next = children[idx + 1];
                if (isJSXElement(next)) {
                    const nextName = next.openingElement?.name;
                    if (nextName && nextName.type === "JSXIdentifier" && nextName.name === op.component) {
                        return;
                    }
                }
            }

            const attrs = Object.entries(op.props || {}).map(([k, v]) => {
                const lit =
                    typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? j.literal(v) : null;
                return j.jsxAttribute(j.jsxIdentifier(k), lit);
            });
            const newEl = j.jsxElement(j.jsxOpeningElement(j.jsxIdentifier(op.component), attrs, true), null, []);
            children.splice(idx + 1, 0, newEl);

            if (op.importPath) {
                this.ctx.importManager.ensureImport(op.importPath, op.component);
            }

            this.ctx.logger.propChange(this.ctx.filePath, this.getName() || "", "appendAfter", "added", op.component);
        });
    }
}
