import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import type { ExpressionKind } from "ast-types/lib/gen/kinds";
import type { Scope } from "ast-types/lib/scope";
import type {
    ASTPath,
    Collection,
    Expression,
    ImportDeclaration,
    ImportDefaultSpecifier,
    ImportNamespaceSpecifier,
    ImportSpecifier,
    JSCodeshift,
    JSXAttribute,
    JSXElement,
    JSXExpressionContainer,
    JSXOpeningElement,
    Literal,
    Node,
    Program,
    StringLiteral,
} from "jscodeshift";
import type { ConditionalTransformation, EnhancedComponentTransformation, JSXChildNode, PropValue } from "./types";

/**
 * AST manipulation helpers for jscodeshift codemods: finding, matching, building and replacing
 * nodes, with JSX props and imports as the two shapes that need the most care.
 */

type JSXAttributeValue = Literal | StringLiteral | JSXExpressionContainer | null;
type ImportSpecifierType = ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier;
type ContainerExpression = JSXExpressionContainer["expression"];

// ============================================================================
// JSX Attribute Utilities
// ============================================================================

/**
 * Extracts the string value from a JSX attribute value
 */
export function getJSXAttributeValue(attr: JSXAttribute): string | undefined {
    if (!attr.value) {
        return undefined;
    }

    // Handle both Literal and StringLiteral (depends on parser)
    if (
        (attr.value.type === "Literal" || attr.value.type === "StringLiteral") &&
        typeof attr.value.value === "string"
    ) {
        return attr.value.value;
    }

    if (attr.value.type === "JSXExpressionContainer") {
        const expr = attr.value.expression;
        if ((expr.type === "Literal" || expr.type === "StringLiteral") && typeof expr.value === "string") {
            return expr.value;
        }
    }

    return undefined;
}

/**
 * Sets a string value on a JSX attribute
 */
export function setJSXAttributeValue(j: JSCodeshift, attr: JSXAttribute, value: string): void {
    if (!attr.value) {
        attr.value = j.literal(value);
        return;
    }

    // Handle both Literal and StringLiteral (depends on parser)
    if (attr.value.type === "Literal" || attr.value.type === "StringLiteral") {
        attr.value.value = value;
    } else if (attr.value.type === "JSXExpressionContainer") {
        const expr = attr.value.expression;
        if (expr.type === "Literal" || expr.type === "StringLiteral") {
            expr.value = value;
        }
    }
}

/**
 * Finds a JSX attribute by name
 */
export function findJSXAttribute(element: JSXOpeningElement, name: string): JSXAttribute | undefined {
    if (!element.attributes) {
        return undefined;
    }

    return element.attributes.find(
        (attr): attr is JSXAttribute =>
            attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name
    );
}

/**
 * Removes a JSX attribute by name
 */
export function removeJSXAttribute(element: JSXOpeningElement, name: string): boolean {
    if (!element.attributes) {
        return false;
    }

    const initialLength = element.attributes.length;
    element.attributes = element.attributes.filter(
        (attr) => !(attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name)
    );

    return element.attributes.length !== initialLength;
}

/**
 * Adds or updates a JSX attribute; `null` removes it
 */
export function setJSXAttribute(j: JSCodeshift, element: JSXOpeningElement, name: string, value: string | null): void {
    const existingAttr = findJSXAttribute(element, name);

    if (existingAttr) {
        if (value === null) {
            removeJSXAttribute(element, name);
        } else {
            setJSXAttributeValue(j, existingAttr, value);
        }
    } else if (value !== null) {
        if (!element.attributes) {
            element.attributes = [];
        }

        element.attributes.push(j.jsxAttribute(j.jsxIdentifier(name), j.stringLiteral(value)));
    }
}

/**
 * Renames a JSX attribute
 */
export function renameJSXAttribute(element: JSXOpeningElement, oldName: string, newName: string): boolean {
    const attr = findJSXAttribute(element, oldName);
    if (attr && attr.name.type === "JSXIdentifier") {
        attr.name.name = newName;
        return true;
    }

    return false;
}

// ============================================================================
// JSX Component Utilities
// ============================================================================

/**
 * Gets the component name from a JSX element
 */
export function getJSXComponentName(element: JSXElement): string | undefined {
    const openingElement = element.openingElement;
    if (openingElement.name.type === "JSXIdentifier") {
        return openingElement.name.name;
    }

    return undefined;
}

/**
 * Sets the component name for a JSX element (both opening and closing tags)
 */
export function setJSXComponentName(element: JSXElement, newName: string): void {
    const openingElement = element.openingElement;
    const closingElement = element.closingElement;

    if (openingElement.name.type === "JSXIdentifier") {
        openingElement.name.name = newName;
    }

    if (closingElement && closingElement.name.type === "JSXIdentifier") {
        closingElement.name.name = newName;
    }
}

/**
 * Configuration for appending elements after a component
 */
export interface AppendAfterConfig {
    /** Component name to append */
    component: string;
    /** Props for the appended component */
    props?: Array<{ name: string; value: string | boolean | number }>;
    /** Import path for the component */
    importPath?: string;
    /** Condition to check before appending */
    onlyIf?: (element: JSXElement) => boolean;
    /** Only append if the next sibling isn't already this component */
    onlyIfUnique?: boolean;
}

/**
 * Determines if an expression should be wrapped with Boolean().
 * Only wraps expressions that are clearly non-boolean values being used in boolean context.
 */
function shouldWrapWithBoolean(expr: ContainerExpression): boolean {
    // Don't wrap identifiers that look like boolean variables (isVisible, hasData, ...)
    if (expr.type === "Identifier") {
        const name = expr.name;
        if (
            name.startsWith("is") ||
            name.startsWith("has") ||
            name.startsWith("should") ||
            name.startsWith("can") ||
            name.startsWith("will") ||
            name.startsWith("enable") ||
            name.startsWith("disable") ||
            name.startsWith("show") ||
            name.startsWith("hide") ||
            name.includes("Bool") ||
            name.includes("Flag") ||
            name.includes("Check")
        ) {
            return false;
        }

        // Other identifiers might be strings/numbers used as booleans
        return true;
    }

    if (expr.type === "StringLiteral" || expr.type === "NumericLiteral") {
        return true;
    }

    // Wrap function calls that don't obviously return boolean
    if (expr.type === "CallExpression") {
        if (expr.callee.type === "MemberExpression") {
            const property = expr.callee.property;
            const methodName = property.type === "Identifier" ? property.name : undefined;
            if (methodName && ["includes", "startsWith", "endsWith", "test", "every", "some"].includes(methodName)) {
                return false;
            }
        }

        return true;
    }

    if (
        expr.type === "BinaryExpression" ||
        expr.type === "LogicalExpression" ||
        expr.type === "ConditionalExpression" ||
        expr.type === "UnaryExpression"
    ) {
        return true;
    }

    // obj.prop might not be boolean
    if (expr.type === "MemberExpression") {
        return true;
    }

    return false;
}

/**
 * Applies a declarative transformation to one JSX element: rename, remove/rename/transform/add props,
 * coerce props to boolean, move props into a nested object, and rewrite children. Returns whether anything changed.
 */
export function transformJSXComponent(
    j: JSCodeshift,
    element: JSXElement,
    transformation: EnhancedComponentTransformation
): boolean {
    let hasChanges = false;

    if (transformation.renameTo) {
        const currentName = getJSXComponentName(element);
        if (currentName && currentName !== transformation.renameTo) {
            setJSXComponentName(element, transformation.renameTo);
            hasChanges = true;
        }
    }

    // Remove props, with "children" meaning: drop all children and self-close
    if (transformation.removeProps) {
        for (const propName of transformation.removeProps) {
            if (propName === "children") {
                if (element.children && element.children.length > 0) {
                    element.children = [];
                    element.openingElement.selfClosing = true;
                    element.closingElement = null;
                    hasChanges = true;
                }

                continue;
            }

            if (removeJSXAttribute(element.openingElement, propName)) {
                hasChanges = true;
            }
        }
    }

    // commentProps are left for the caller's transformer, which adds the comments

    if (transformation.renameProps) {
        for (const [oldName, newName] of Object.entries(transformation.renameProps)) {
            if (renameJSXAttribute(element.openingElement, oldName, newName)) {
                hasChanges = true;
            }
        }
    }

    if (transformation.transformProps) {
        for (const [propName, transformer] of Object.entries(transformation.transformProps)) {
            const attr = findJSXAttribute(element.openingElement, propName);
            if (attr?.value) {
                const oldValue = getJSXAttributeValue(attr);
                if (oldValue !== undefined) {
                    const newValue = transformer(oldValue, j);
                    if (newValue !== undefined && newValue !== oldValue) {
                        setJSXAttributeValue(j, attr, newValue);
                        hasChanges = true;
                    }
                }
            }
        }
    }

    if (transformation.addProps) {
        for (const [propName, value] of Object.entries(transformation.addProps)) {
            if (!findJSXAttribute(element.openingElement, propName)) {
                setJSXAttribute(j, element.openingElement, propName, value);
                hasChanges = true;
            }
        }
    }

    // Wrap non-boolean values with Boolean()
    if (transformation.ensurePropsAreBoolean) {
        for (const propName of transformation.ensurePropsAreBoolean) {
            const attr = findJSXAttribute(element.openingElement, propName);
            if (attr?.value?.type !== "JSXExpressionContainer") {
                continue;
            }

            const container = attr.value;
            const expr = container.expression;

            if (expr.type === "BooleanLiteral") {
                continue;
            }

            if (expr.type === "CallExpression" && expr.callee.type === "Identifier" && expr.callee.name === "Boolean") {
                continue;
            }

            if (expr.type !== "JSXEmptyExpression" && shouldWrapWithBoolean(expr)) {
                container.expression = j.callExpression(j.identifier("Boolean"), [expr]);
                hasChanges = true;
            }
        }
    }

    if (transformation.movePropsToNested) {
        for (const [propName, config] of Object.entries(transformation.movePropsToNested)) {
            if (movePropToNestedObject(j, element, propName, config.targetProp, config.nestedProp)) {
                hasChanges = true;
            }
        }
    }

    if (transformation.transformChildren && element.children) {
        const newChildren = transformation.transformChildren(element.children, j, element);
        if (newChildren !== element.children) {
            element.children = newChildren;
            hasChanges = true;
        }
    }

    return hasChanges;
}

// ============================================================================
// JSX Element Utilities
// ============================================================================

/**
 * Check if element has a prop by name (any value)
 */
export function hasJSXProperty(element: JSXElement, propName: string): boolean {
    return (
        element.openingElement.attributes?.some(
            (attr) => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === propName
        ) ?? false
    );
}

/**
 * Check if a JSX attribute is boolean: bare (`<A b />`) or `{true}` / `{false}`
 */
export function isBooleanJsxAttribute(_j: JSCodeshift, attr: JSXAttribute): boolean {
    if (attr.value == null) {
        return true;
    }

    if (attr.value.type === "JSXExpressionContainer") {
        const expr = attr.value.expression;
        if (expr.type === "BooleanLiteral") {
            return true;
        }
    }

    return false;
}

/**
 * Check if two JSX elements are identical (same name and props). Only string and boolean literal
 * values compare equal; any other value makes the elements differ.
 */
export function areElementsIdentical(_j: JSCodeshift, elem1: JSXElement, elem2: JSXElement): boolean {
    const name1 = elem1.openingElement.name;
    const name2 = elem2.openingElement.name;
    if (name1.type !== "JSXIdentifier" || name2.type !== "JSXIdentifier") {
        return false;
    }

    if (name1.name !== name2.name) {
        return false;
    }

    const attrs1 = elem1.openingElement.attributes ?? [];
    const attrs2 = elem2.openingElement.attributes ?? [];
    if (attrs1.length !== attrs2.length) {
        return false;
    }

    return attrs1.every((attr1, index) => {
        const attr2 = attrs2[index];
        if (!attr2 || attr1.type !== "JSXAttribute" || attr2.type !== "JSXAttribute") {
            return false;
        }

        if (attr1.name.type !== "JSXIdentifier" || attr2.name.type !== "JSXIdentifier") {
            return false;
        }

        if (attr1.name.name !== attr2.name.name) {
            return false;
        }

        if (attr1.value?.type === "StringLiteral" && attr2.value?.type === "StringLiteral") {
            return attr1.value.value === attr2.value.value;
        }

        if (attr1.value?.type === "JSXExpressionContainer" && attr2.value?.type === "JSXExpressionContainer") {
            const expr1 = attr1.value.expression;
            const expr2 = attr2.value.expression;
            if (expr1.type === "BooleanLiteral" && expr2.type === "BooleanLiteral") {
                return expr1.value === expr2.value;
            }
        }

        return false;
    });
}

// ============================================================================
// Import Utilities
// ============================================================================

/** `{ imported }`, or `{ imported as local }` when the names differ */
function namedImportSpecifier(j: JSCodeshift, imported: string, local: string): ImportSpecifier {
    return imported === local
        ? j.importSpecifier(j.identifier(imported))
        : j.importSpecifier(j.identifier(imported), j.identifier(local));
}

/**
 * Collects all named imports from a specific module, as imported name -> local name
 */
export function getImportsFromModule(
    j: JSCodeshift,
    root: Collection<Program>,
    moduleName: string
): Map<string, string> {
    const imports = new Map<string, string>();

    root.find(j.ImportDeclaration, {
        source: { value: moduleName },
    }).forEach((path) => {
        const specifiers = path.node.specifiers || [];
        for (const spec of specifiers) {
            if (spec.type === "ImportSpecifier" && spec.imported && spec.imported.type === "Identifier") {
                const importedName = String(spec.imported.name);
                const localName = String(spec.local?.name ?? importedName);
                imports.set(importedName, localName);
            }
        }
    });

    return imports;
}

/**
 * One module's import rewrite for `transformImports`
 */
export interface ImportTransformation {
    fromModule: string;
    toModule?: string;
    namedImports?: {
        [importName: string]: {
            rename?: string;
            remove?: boolean;
            toModule?: string;
            localName?: string;
        };
    };
    defaultImport?: {
        toModule?: string;
        /** Convert the default import to this named import */
        toNamed?: string;
        remove?: boolean;
    };
    removeAll?: boolean;
}

/**
 * Applies import rewrites: remove a module's imports, move or rename named imports, convert or move
 * the default import, or rename the module. Returns whether anything changed.
 */
export function transformImports(
    j: JSCodeshift,
    root: Collection<Program>,
    transformations: ImportTransformation[]
): boolean {
    let hasChanges = false;

    for (const transformation of transformations) {
        const { fromModule, toModule, namedImports, defaultImport, removeAll } = transformation;

        if (removeAll) {
            const imports = root.find(j.ImportDeclaration, { source: { value: fromModule } });
            if (imports.length > 0) {
                imports.remove();
                hasChanges = true;
            }

            continue;
        }

        if (namedImports) {
            const importsByNewModule = new Map<string, Map<string, string>>();

            root.find(j.ImportDeclaration, { source: { value: fromModule } }).forEach((path) => {
                const declaration = path.node;
                const remainingSpecifiers: ImportSpecifierType[] = [];

                for (const spec of declaration.specifiers || []) {
                    if (spec.type === "ImportSpecifier" && spec.imported && spec.imported.type === "Identifier") {
                        const importedName = String(spec.imported.name);
                        const localName = spec.local?.name || importedName;
                        const named = namedImports[importedName];

                        if (!named) {
                            remainingSpecifiers.push(spec);
                            continue;
                        }

                        if (named.remove) {
                            hasChanges = true;
                            continue;
                        }

                        const targetModule = named.toModule || toModule || fromModule;
                        const newImportName = named.rename || importedName;

                        let moduleImports = importsByNewModule.get(targetModule);
                        if (!moduleImports) {
                            moduleImports = new Map();
                            importsByNewModule.set(targetModule, moduleImports);
                        }

                        // A component rename (both names capitalized, e.g. Text -> Label) renames the local
                        // binding too; a utility rename keeps the local name so existing call sites still resolve
                        const isComponentRename = /^[A-Z]/.test(importedName) && /^[A-Z]/.test(newImportName);
                        const newLocalName = String(isComponentRename ? newImportName : localName);
                        moduleImports.set(newImportName, newLocalName);
                        hasChanges = true;
                    } else {
                        // default and namespace specifiers stay where they are
                        remainingSpecifiers.push(spec);
                    }
                }

                if (remainingSpecifiers.length === 0) {
                    j(path).remove();
                } else if (remainingSpecifiers.length !== declaration.specifiers?.length) {
                    declaration.specifiers = remainingSpecifiers;
                    if (toModule && toModule !== fromModule) {
                        declaration.source.value = toModule;
                    }
                }
            });

            // Always add, even when staying in the same module (a rename)
            importsByNewModule.forEach((imports, moduleName) => {
                addOrUpdateImport(j, root, moduleName, imports);
            });
        }

        if (defaultImport) {
            root.find(j.ImportDeclaration, { source: { value: fromModule } }).forEach((path) => {
                const declaration = path.node;
                const remainingSpecifiers: ImportSpecifierType[] = [];
                // a named specifier cannot share a declaration with a namespace one, so it goes into its own
                const hasNamespace = (declaration.specifiers || []).some((s) => s.type === "ImportNamespaceSpecifier");
                const separateSpecifiers: ImportSpecifier[] = [];
                let defaultImportFound = false;

                for (const spec of declaration.specifiers || []) {
                    if (spec.type !== "ImportDefaultSpecifier") {
                        remainingSpecifiers.push(spec);
                        continue;
                    }

                    defaultImportFound = true;

                    if (defaultImport.remove) {
                        hasChanges = true;
                    } else if (defaultImport.toNamed) {
                        const targetModule = defaultImport.toModule || toModule || fromModule;
                        const localName = String(spec.local?.name ?? "default");

                        if (targetModule === fromModule) {
                            // this declaration is the destination, and its specifiers are rewritten below, so the
                            // named specifier takes the default's place instead of going through addOrUpdateImport
                            const named = namedImportSpecifier(j, defaultImport.toNamed, localName);
                            if (hasNamespace) {
                                separateSpecifiers.push(named);
                            } else {
                                remainingSpecifiers.push(named);
                            }
                        } else {
                            addOrUpdateImport(j, root, targetModule, new Map([[defaultImport.toNamed, localName]]));
                        }

                        hasChanges = true;
                    } else if (defaultImport.toModule && defaultImport.toModule !== fromModule) {
                        const existingImport = root
                            .find(j.ImportDeclaration, {
                                source: { value: defaultImport.toModule },
                            })
                            .at(0);

                        if (existingImport.length > 0) {
                            const node: ImportDeclaration = existingImport.get().node;
                            if (!node.specifiers) {
                                node.specifiers = [];
                            }

                            // a default specifier goes first
                            node.specifiers.unshift(spec);
                        } else {
                            const newImport = j.importDeclaration([spec], j.literal(defaultImport.toModule));
                            const firstImport = root.find(j.ImportDeclaration).at(0);
                            if (firstImport.length > 0) {
                                firstImport.insertBefore(newImport);
                            } else {
                                const program = root.find(j.Program).at(0);
                                program.get("body", 0).insertBefore(newImport);
                            }
                        }

                        hasChanges = true;
                    } else {
                        remainingSpecifiers.push(spec);
                    }
                }

                if (defaultImportFound && (defaultImport.remove || defaultImport.toNamed || defaultImport.toModule)) {
                    if (remainingSpecifiers.length === 0) {
                        j(path).remove();
                    } else {
                        declaration.specifiers = remainingSpecifiers;
                    }
                }

                if (separateSpecifiers.length > 0) {
                    j(path).insertAfter(j.importDeclaration(separateSpecifiers, j.literal(fromModule)));
                }
            });
        } else if (toModule && toModule !== fromModule) {
            root.find(j.ImportDeclaration, { source: { value: fromModule } }).forEach((path) => {
                path.node.source.value = toModule;
                hasChanges = true;
            });
        }
    }

    return hasChanges;
}

/**
 * Collects the local names of every named and default import in the file
 */
export function getAllImports(j: JSCodeshift, root: Collection<Program>): Set<string> {
    const allImports = new Set<string>();

    root.find(j.ImportDeclaration).forEach((path) => {
        for (const spec of path.node.specifiers || []) {
            if ((spec.type === "ImportSpecifier" || spec.type === "ImportDefaultSpecifier") && spec.local) {
                allImports.add(String(spec.local.name));
            }
        }
    });

    return allImports;
}

/**
 * True when named value imports can be added to this declaration: it is not `import type`, has no namespace
 * specifier (`import * as UI` cannot take named ones), and is not a side-effect-only import.
 */
export function acceptsNamedImports(node: ImportDeclaration): boolean {
    const specifiers = node.specifiers || [];
    return (
        node.importKind !== "type" &&
        specifiers.length > 0 &&
        !specifiers.some((spec) => spec.type === "ImportNamespaceSpecifier")
    );
}

/**
 * Adds named imports (imported name -> local name) to one of the module's imports that accepts them
 * (`acceptsNamedImports`), or creates a new import after the last existing one. A name any import of the
 * module already brings in is skipped. The updated import keeps its default specifier, and its named
 * specifiers are re-sorted by imported name.
 */
export function addOrUpdateImport(
    j: JSCodeshift,
    root: Collection<Program>,
    moduleName: string,
    imports: Map<string, string>
): void {
    const declarations = root.find(j.ImportDeclaration, { source: { value: moduleName } }).paths();
    const alreadyImported = new Set(
        declarations.flatMap((path) =>
            (path.node.specifiers || []).flatMap((spec) =>
                spec.type === "ImportSpecifier" ? [importedNameOf(spec)] : []
            )
        )
    );
    const missing = Array.from(imports.entries())
        .filter(([imported]) => !alreadyImported.has(imported))
        .sort((a, b) => a[0].localeCompare(b[0]));

    if (missing.length === 0) {
        return;
    }

    const added = missing.map(([imported, local]) => namedImportSpecifier(j, imported, local));
    const target = declarations.find((path) => acceptsNamedImports(path.node));

    if (target) {
        const specifiers = target.node.specifiers || [];
        const named = [...specifiers.filter((spec) => spec.type === "ImportSpecifier"), ...added].sort((a, b) =>
            importedNameOf(a).localeCompare(importedNameOf(b))
        );
        target.node.specifiers = [...specifiers.filter((spec) => spec.type === "ImportDefaultSpecifier"), ...named];
        return;
    }

    const newImport = j.importDeclaration(added, j.literal(moduleName));

    const allImports = root.find(j.ImportDeclaration);
    if (allImports.length > 0) {
        j(allImports.at(-1).get()).insertAfter(newImport);
    } else {
        const firstStatement = root.find(j.Program).get("body", 0);
        j(firstStatement).insertBefore(newImport);
    }
}

/**
 * Checks if a node is a JSX tag name (to avoid renaming in wrong places)
 */
export function isInJSXContext(path: ASTPath<Node>): boolean {
    const parent: unknown = path.parent?.node;
    if (typeof parent !== "object" || parent === null || !("type" in parent)) {
        return false;
    }

    return (
        parent.type === "JSXOpeningElement" ||
        parent.type === "JSXClosingElement" ||
        parent.type === "JSXMemberExpression"
    );
}

/**
 * Checks if a node is a non-computed property key or member property (to avoid renaming object keys)
 */
export function isPropertyKey(path: ASTPath<Node>): boolean {
    const parent: unknown = path.parent?.node;
    if (typeof parent !== "object" || parent === null || !("type" in parent)) {
        return false;
    }

    const computed = "computed" in parent && Boolean(parent.computed);

    if (parent.type === "Property" || parent.type === "ObjectProperty") {
        return "key" in parent && parent.key === path.node && !computed;
    }

    if (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") {
        return "property" in parent && parent.property === path.node && !computed;
    }

    return false;
}

/**
 * Runs `callback` on every JSX element whose name is in `componentNames`; true when any callback returned true
 */
export function processJSXElements(
    j: JSCodeshift,
    root: Collection<Program>,
    componentNames: string[],
    callback: (element: JSXElement, componentName: string) => boolean
): boolean {
    let hasModifications = false;

    root.find(j.JSXElement).forEach((path) => {
        const componentName = getJSXComponentName(path.node);
        if (componentName && componentNames.includes(componentName)) {
            if (callback(path.node, componentName)) {
                hasModifications = true;
            }
        }
    });

    return hasModifications;
}

/**
 * Runs `callback` on one named attribute of every `componentName` element; true when any callback returned true
 */
export function processJSXAttributes(
    j: JSCodeshift,
    root: Collection<Program>,
    componentName: string,
    attributeName: string,
    callback: (attr: JSXAttribute, element: JSXElement) => boolean
): boolean {
    let hasModifications = false;

    root.find(j.JSXElement).forEach((path) => {
        const element = path.node;
        const name = getJSXComponentName(element);

        if (name === componentName) {
            const attr = findJSXAttribute(element.openingElement, attributeName);
            if (attr && callback(attr, element)) {
                hasModifications = true;
            }
        }
    });

    return hasModifications;
}

/**
 * Collects warnings per file and prints them to stderr at the end of a run
 */
export class WarningCollector {
    private warnings: Map<string, string[]> = new Map();

    add(filePath: string, warning: string): void {
        const list = this.warnings.get(filePath);
        if (list) {
            list.push(warning);
            return;
        }

        this.warnings.set(filePath, [warning]);
    }

    print(): void {
        this.warnings.forEach((warnings, filePath) => {
            if (warnings.length > 0) {
                ui.raw(`\n${filePath}:`);
                for (const w of warnings) {
                    ui.raw(`  ⚠️  ${w}`);
                }
            }
        });
    }

    hasWarnings(): boolean {
        return this.warnings.size > 0;
    }
}

/**
 * Removes named imports from a module and returns them as imported name -> local name
 */
export function removeImportsFromModule(
    j: JSCodeshift,
    root: Collection<Program>,
    moduleName: string,
    importsToRemove: Set<string>
): Map<string, string> {
    const removedImports = new Map<string, string>();

    root.find(j.ImportDeclaration, {
        source: { value: moduleName },
    }).forEach((path) => {
        const specifiers = path.node.specifiers || [];
        const remainingSpecifiers = specifiers.filter((spec) => {
            if (
                spec.type === "ImportSpecifier" &&
                spec.imported &&
                spec.imported.type === "Identifier" &&
                importsToRemove.has(spec.imported.name)
            ) {
                const importedName = String(spec.imported.name);
                const localName = String(spec.local?.name ?? importedName);
                removedImports.set(importedName, localName);
                return false;
            }

            return true;
        });

        if (remainingSpecifiers.length === 0 && specifiers.length > 0) {
            j(path).remove();
        } else if (remainingSpecifiers.length !== specifiers.length) {
            path.node.specifiers = remainingSpecifiers;
        }
    });

    return removedImports;
}

/**
 * Checks if a named import already exists in the file
 */
export function hasImport(j: JSCodeshift, root: Collection<Program>, moduleName: string, importName: string): boolean {
    return getImportsFromModule(j, root, moduleName).has(importName);
}

/**
 * Moves named imports from one module to another, optionally renaming them (original name -> new name)
 * @returns Map of moved imports (importName -> localName)
 */
export function moveImports(
    j: JSCodeshift,
    root: Collection<Program>,
    fromModule: string,
    toModule: string,
    importsToMove: Set<string>,
    importMappings?: Map<string, string>
): Map<string, string> {
    const movedImports = new Map<string, string>();
    const imports = getImportsFromModule(j, root, fromModule);
    const toMove = new Map<string, string>();

    imports.forEach((localName, importedName) => {
        if (importsToMove.has(importedName)) {
            const newImportName = importMappings?.get(importedName) || importedName;
            toMove.set(newImportName, localName);
            movedImports.set(importedName, localName);
        }
    });

    if (toMove.size === 0) {
        return movedImports;
    }

    removeImportsFromModule(j, root, fromModule, importsToMove);

    const allDestImports = new Map(getImportsFromModule(j, root, toModule));

    toMove.forEach((localName, importName) => {
        if (!allDestImports.has(importName)) {
            allDestImports.set(importName, localName);
        }
    });

    addOrUpdateImport(j, root, toModule, allDestImports);

    return movedImports;
}

function importedNameOf(spec: ImportSpecifier): string {
    return spec.imported?.type === "Identifier" ? spec.imported.name : "";
}

/**
 * Consolidates multiple import declarations from the same module into one, keeping type imports
 * separate from value imports. Named specifiers end up sorted; one default and one namespace survive.
 */
export function consolidateImportsFromModule(j: JSCodeshift, root: Collection<Program>, moduleName: string): boolean {
    const imports = root.find(j.ImportDeclaration, {
        source: { value: moduleName },
    });

    if (imports.length <= 1) {
        return false;
    }

    let hasModifications = false;
    const typeImports: ASTPath<ImportDeclaration>[] = [];
    const regularImports: ASTPath<ImportDeclaration>[] = [];

    imports.forEach((path) => {
        if (path.node.importKind === "type") {
            typeImports.push(path);
        } else {
            regularImports.push(path);
        }
    });

    const firstTypeImport = typeImports[0];
    if (typeImports.length > 1 && firstTypeImport) {
        const typeNamedImports = new Map<string, ImportSpecifier>();

        for (const path of typeImports) {
            for (const spec of path.node.specifiers || []) {
                if (spec.type === "ImportSpecifier" && spec.imported && spec.imported.type === "Identifier") {
                    const importedName = String(spec.imported.name);
                    if (!typeNamedImports.has(importedName)) {
                        typeNamedImports.set(importedName, spec);
                    }
                }
            }

            if (path !== firstTypeImport) {
                j(path).remove();
                hasModifications = true;
            }
        }

        if (typeNamedImports.size > 0) {
            firstTypeImport.node.specifiers = Array.from(typeNamedImports.values()).sort((a, b) =>
                importedNameOf(a).localeCompare(importedNameOf(b))
            );
            hasModifications = true;
        }
    }

    const firstRegularImport = regularImports[0];
    if (regularImports.length > 1 && firstRegularImport) {
        const namedImports = new Map<string, ImportSpecifier>();
        const defaultImports: ImportDefaultSpecifier[] = [];
        const namespaceImports: ImportNamespaceSpecifier[] = [];

        for (const path of regularImports) {
            for (const spec of path.node.specifiers || []) {
                if (spec.type === "ImportSpecifier" && spec.imported && spec.imported.type === "Identifier") {
                    const importedName = String(spec.imported.name);
                    if (!namedImports.has(importedName)) {
                        namedImports.set(importedName, spec);
                    }
                } else if (spec.type === "ImportDefaultSpecifier") {
                    if (defaultImports.length === 0) {
                        defaultImports.push(spec);
                    }
                } else if (spec.type === "ImportNamespaceSpecifier") {
                    if (namespaceImports.length === 0) {
                        namespaceImports.push(spec);
                    }
                }
            }

            if (path !== firstRegularImport) {
                j(path).remove();
                hasModifications = true;
            }
        }

        const consolidatedSpecifiers: ImportSpecifierType[] = [
            ...defaultImports,
            ...namespaceImports,
            ...Array.from(namedImports.values()).sort((a, b) => importedNameOf(a).localeCompare(importedNameOf(b))),
        ];

        if (consolidatedSpecifiers.length > 0) {
            firstRegularImport.node.specifiers = consolidatedSpecifiers;
            hasModifications = true;
        }
    }

    return hasModifications;
}

// ============================================================================
// Component-specific Utilities
// ============================================================================

/**
 * Replaces a component with custom JSX
 */
export function replaceComponentWithJSX(
    j: JSCodeshift,
    element: JSXElement,
    replacementFactory: (element: JSXElement, j: JSCodeshift) => JSXElement | Expression
): JSXElement | Expression {
    return replacementFactory(element, j);
}

/**
 * Wraps a component with another component that carries string props
 */
export function wrapComponent(
    j: JSCodeshift,
    element: JSXElement,
    wrapperName: string,
    wrapperProps?: Record<string, string>
): JSXElement {
    return j.jsxElement(
        j.jsxOpeningElement(
            j.jsxIdentifier(wrapperName),
            Object.entries(wrapperProps || {}).map(([key, value]) =>
                j.jsxAttribute(j.jsxIdentifier(key), j.stringLiteral(value))
            )
        ),
        j.jsxClosingElement(j.jsxIdentifier(wrapperName)),
        [element]
    );
}

/**
 * Checks if a JSX element has any of the specified attributes
 */
export function hasAnyAttribute(element: JSXElement, attributeNames: string[]): boolean {
    return attributeNames.some((name) => findJSXAttribute(element.openingElement, name) !== undefined);
}

/**
 * Moves a prop's value into the element's children: a string becomes text, an expression stays in `{}`
 */
export function extractPropToChildren(j: JSCodeshift, element: JSXElement, propName: string): boolean {
    const attr = findJSXAttribute(element.openingElement, propName);

    if (!attr?.value) {
        return false;
    }

    let childContent: JSXChildNode | undefined;

    if (attr.value.type === "StringLiteral" || attr.value.type === "Literal") {
        childContent = j.jsxText(String(attr.value.value));
    } else if (attr.value.type === "JSXExpressionContainer") {
        childContent = attr.value;
    }

    if (!childContent) {
        return false;
    }

    removeJSXAttribute(element.openingElement, propName);

    element.children = element.children || [];
    element.children.push(childContent);

    if (element.openingElement.selfClosing) {
        element.openingElement.selfClosing = false;
        element.closingElement = j.jsxClosingElement(element.openingElement.name);
    }

    return true;
}

/**
 * Gets all attribute names from a JSX element (spread attributes have none)
 */
export function getAttributeNames(element: JSXElement): string[] {
    if (!element.openingElement.attributes) {
        return [];
    }

    return element.openingElement.attributes
        .filter((attr): attr is JSXAttribute => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier")
        .map((attr) => String(attr.name.name));
}

/**
 * Copies attributes the target does not already have, optionally only the named ones
 */
export function copyAttributes(
    _j: JSCodeshift,
    fromElement: JSXElement,
    toElement: JSXElement,
    attributesToCopy?: string[]
): void {
    for (const attr of fromElement.openingElement.attributes || []) {
        if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier") {
            continue;
        }

        const attrName = attr.name.name;
        if (attributesToCopy && !attributesToCopy.includes(attrName)) {
            continue;
        }

        if (!findJSXAttribute(toElement.openingElement, attrName)) {
            if (!toElement.openingElement.attributes) {
                toElement.openingElement.attributes = [];
            }

            toElement.openingElement.attributes.push(attr);
        }
    }
}

/**
 * True when the identifier at `path` reads a binding: not a declaration's own name, a non-computed key or member
 * property, a JSX attribute name, an intrinsic JSX tag (`<div>`), a label, or part of an import specifier.
 */
function isBindingReference(j: JSCodeshift, path: ASTPath<Node>): boolean {
    const parentPath: ASTPath<Node> | null = path.parent;
    const parent = parentPath?.node;
    const node = path.node;

    if (!parent) {
        return false;
    }

    if (
        j.ImportSpecifier.check(parent) ||
        j.ImportDefaultSpecifier.check(parent) ||
        j.ImportNamespaceSpecifier.check(parent) ||
        j.JSXAttribute.check(parent) ||
        j.JSXNamespacedName.check(parent) ||
        j.LabeledStatement.check(parent) ||
        j.BreakStatement.check(parent) ||
        j.ContinueStatement.check(parent)
    ) {
        return false;
    }

    if (j.ExportSpecifier.check(parent)) {
        // `export { Button } from "./x"` names the other module's export, not a binding of this file
        const declaration = parentPath?.parent?.node;
        return parent.local === node && !(j.ExportNamedDeclaration.check(declaration) && declaration.source);
    }

    if (j.MemberExpression.check(parent) || j.JSXMemberExpression.check(parent)) {
        return parent.object === node || Boolean(parent.computed);
    }

    if (j.TSQualifiedName.check(parent)) {
        return parent.left === node;
    }

    if (j.JSXOpeningElement.check(parent) || j.JSXClosingElement.check(parent)) {
        return !(j.JSXIdentifier.check(node) && /^[a-z]/.test(node.name));
    }

    if ((j.Property.check(parent) || j.ObjectProperty.check(parent)) && parent.shorthand && parent.value === node) {
        return true;
    }

    if ("key" in parent && parent.key === node) {
        return "computed" in parent && parent.computed === true;
    }

    return !("id" in parent && parent.id === node);
}

/** True when no scope between the identifier and the module scope declares `name` again. */
function refersToModuleBinding(path: ASTPath<Node>, name: string): boolean {
    let scope: Scope | null = path.scope;

    while (scope && !scope.isGlobal) {
        if (scope.declares(name)) {
            return false;
        }

        scope = scope.parent;
    }

    return scope !== null;
}

/**
 * Renames every reference to the module-scope binding `oldName`, such as an import's local name: expressions
 * (`memo(Button)`, `Button.displayName`), JSX tags and the object of a JSX member tag (`<Button.Label />`), type
 * references and `typeof`. A reference to an inner binding that shadows the name stays, and so do property keys,
 * member properties and JSX attribute names. A shorthand property keeps its key (`{ Button: LocalButton }`) and an
 * export specifier the name it exports (`export { LocalButton as Button }`). The declaration that binds the name,
 * such as the import specifier, is left to the caller.
 */
export function renameModuleBinding(j: JSCodeshift, root: Collection, oldName: string, newName: string): void {
    root.find(j.Identifier, { name: oldName }).forEach((path) => {
        if (!isBindingReference(j, path) || !refersToModuleBinding(path, oldName)) {
            return;
        }

        const parentPath: ASTPath<Node> = path.parent;
        const parent = parentPath.node;

        // a fresh node, not a new name on the shared one: recast patches the single source token that a shorthand
        // property or export specifier prints for both of its names, which would rename the key or export too
        if (j.ObjectProperty.check(parent) && parent.shorthand) {
            parentPath.replace(j.objectProperty(j.identifier(oldName), j.identifier(newName)));
            return;
        }

        if (j.Property.check(parent) && parent.shorthand) {
            parentPath.replace(j.property("init", j.identifier(oldName), j.identifier(newName)));
            return;
        }

        if (j.ExportSpecifier.check(parent)) {
            // the exported name stays whatever it was (`export { Button as PublicButton }` keeps PublicButton), and
            // so does an `export type` marker on the specifier
            const exportedName = typeof parent.exported?.name === "string" ? parent.exported.name : oldName;
            const replacement = j.exportSpecifier.from({
                local: j.identifier(newName),
                exported: j.identifier(exportedName),
            });
            parentPath.replace(
                "exportKind" in parent ? Object.assign(replacement, { exportKind: parent.exportKind }) : replacement
            );
            return;
        }

        path.node.name = newName;
    });
}

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Renames TypeScript type references and the matching import specifiers
 */
export function updateTypeReferences(
    j: JSCodeshift,
    root: Collection<Program>,
    typeRenames: Record<string, string>
): boolean {
    let hasChanges = false;

    root.find(j.TSTypeReference).forEach((path) => {
        if (path.node.typeName.type === "Identifier") {
            const renamed = typeRenames[path.node.typeName.name];
            if (renamed) {
                path.node.typeName.name = renamed;
                hasChanges = true;
            }
        }
    });

    root.find(j.ImportSpecifier).forEach((path) => {
        if (path.node.imported.type === "Identifier") {
            const importedName = path.node.imported.name;
            const renamed = typeRenames[importedName];
            if (renamed) {
                path.node.imported.name = renamed;
                if (path.node.local && path.node.local.name === importedName) {
                    path.node.local.name = renamed;
                }

                hasChanges = true;
            }
        }
    });

    return hasChanges;
}

function nestedValueOf(j: JSCodeshift, value: NonNullable<JSXAttribute["value"]>): ExpressionKind {
    if (value.type === "StringLiteral" || value.type === "Literal") {
        return value;
    }

    if (value.type === "JSXExpressionContainer" && value.expression.type !== "JSXEmptyExpression") {
        return value.expression;
    }

    return j.literal("");
}

/**
 * Moves a prop to a nested object prop.
 * Example: label="foo" -> fieldProps={{ label: "foo" }}
 * When the target prop exists but is not an object literal (`fieldProps={props}`), nothing changes: the
 * source prop stays, a warning is logged, and the result is false.
 */
export function movePropToNestedObject(
    j: JSCodeshift,
    element: JSXElement,
    sourcePropName: string,
    targetPropName: string,
    nestedPropName: string
): boolean {
    const sourceAttr = findJSXAttribute(element.openingElement, sourcePropName);
    if (!sourceAttr?.value) {
        return false;
    }

    const propValue = nestedValueOf(j, sourceAttr.value);
    const targetAttr = findJSXAttribute(element.openingElement, targetPropName);

    if (targetAttr) {
        const expr = targetAttr.value?.type === "JSXExpressionContainer" ? targetAttr.value.expression : undefined;
        if (expr?.type !== "ObjectExpression") {
            logger.warn(
                { component: getJSXComponentName(element), sourcePropName, targetPropName },
                "movePropToNestedObject: the target prop is not an object literal, so the source prop stays"
            );
            return false;
        }

        expr.properties.push(j.property("init", j.identifier(nestedPropName), propValue));
    } else {
        const newProp = j.jsxAttribute(
            j.jsxIdentifier(targetPropName),
            j.jsxExpressionContainer(j.objectExpression([j.property("init", j.identifier(nestedPropName), propValue)]))
        );

        element.openingElement.attributes = element.openingElement.attributes || [];
        element.openingElement.attributes.push(newProp);
    }

    removeJSXAttribute(element.openingElement, sourcePropName);

    return true;
}

/**
 * Adds a named import for a type that is referenced but not yet imported from `fromModule`
 */
export function ensureTypeImport(
    j: JSCodeshift,
    root: Collection<Program>,
    typeName: string,
    fromModule: string
): boolean {
    if (hasImport(j, root, fromModule, typeName)) {
        return false;
    }

    const isUsed =
        root.find(j.TSTypeReference, {
            typeName: {
                type: "Identifier",
                name: typeName,
            },
        }).length > 0;

    if (isUsed) {
        const imports = new Map<string, string>();
        imports.set(typeName, typeName);
        addOrUpdateImport(j, root, fromModule, imports);
        return true;
    }

    return false;
}

// ============================================================================
// Enhanced Prop Manipulation Utilities
// ============================================================================

/**
 * Creates a JSX attribute value from a PropValue
 */
export function createJSXAttributeValue(j: JSCodeshift, value: PropValue): JSXAttributeValue | null {
    if (value === null) {
        return null;
    }

    if (typeof value === "string") {
        return j.stringLiteral(value);
    }

    if (typeof value === "boolean") {
        return j.jsxExpressionContainer(j.booleanLiteral(value));
    }

    switch (value.type) {
        case "string":
            return j.stringLiteral(value.value);

        case "boolean":
            return j.jsxExpressionContainer(j.booleanLiteral(value.value));

        case "enum":
            return j.jsxExpressionContainer(j.memberExpression(j.identifier(value.name), j.identifier(value.value)));

        case "identifier":
            return j.jsxExpressionContainer(j.identifier(value.name));

        case "expression":
            try {
                const statement = j(value.code).find(j.Program).get("body", 0).node;
                if (statement && statement.type === "ExpressionStatement") {
                    return j.jsxExpressionContainer(statement.expression);
                }
            } catch (err) {
                logger.warn({ err, code: value.code }, "createJSXAttributeValue: failed to parse expression");
            }

            return null;
    }

    return null;
}

/**
 * Sets a prop value on a JSX element using PropValue: updates an existing prop, adds a missing one,
 * removes it for `null`
 */
export function setPropValue(j: JSCodeshift, element: JSXOpeningElement, propName: string, value: PropValue): boolean {
    if (value === null) {
        return removeJSXAttribute(element, propName);
    }

    const attributeValue = createJSXAttributeValue(j, value);
    if (!attributeValue) {
        return false;
    }

    const existingAttr = findJSXAttribute(element, propName);

    if (existingAttr) {
        existingAttr.value = attributeValue;
        return true;
    }

    if (!element.attributes) {
        element.attributes = [];
    }

    element.attributes.push(j.jsxAttribute(j.jsxIdentifier(propName), attributeValue));
    return true;
}

/**
 * Adds a new prop only if it doesn't already exist
 */
export function addNewProp(j: JSCodeshift, element: JSXOpeningElement, propName: string, value: PropValue): boolean {
    if (findJSXAttribute(element, propName)) {
        return false;
    }

    return setPropValue(j, element, propName, value);
}

/**
 * Reads a prop as a PropValue: string, boolean, identifier, or `Enum.MEMBER` as an enum value
 */
export function getPropValue(element: JSXOpeningElement, propName: string): PropValue | undefined {
    const attr = findJSXAttribute(element, propName);
    if (!attr?.value) {
        return undefined;
    }

    if (attr.value.type === "StringLiteral" || attr.value.type === "Literal") {
        return String(attr.value.value);
    }

    if (attr.value.type === "JSXExpressionContainer") {
        const expr = attr.value.expression;

        if (expr.type === "BooleanLiteral") {
            return expr.value;
        }

        if ((expr.type === "StringLiteral" || expr.type === "Literal") && typeof expr.value === "string") {
            return expr.value;
        }

        if (expr.type === "Identifier") {
            return {
                type: "identifier",
                name: expr.name,
            };
        }

        if (
            expr.type === "MemberExpression" &&
            expr.object.type === "Identifier" &&
            expr.property.type === "Identifier"
        ) {
            return {
                type: "enum",
                name: expr.object.name,
                value: expr.property.name,
            };
        }
    }

    return undefined;
}

type ConditionalChange = { type: string; propName?: string; newName?: string; value?: PropValue };

/**
 * Applies every transformation whose condition holds for the element
 */
export function applyConditionalTransformations(
    j: JSCodeshift,
    element: JSXElement,
    transformations: ConditionalTransformation[]
): { hasChanges: boolean; changes: ConditionalChange[] } {
    let hasChanges = false;
    const changes: ConditionalChange[] = [];

    for (const transformation of transformations) {
        if (!transformation.condition(element)) {
            continue;
        }

        if (transformation.renameTo) {
            setJSXComponentName(element, transformation.renameTo);
            hasChanges = true;
            changes.push({ type: "rename", newName: transformation.renameTo });
        }

        if (transformation.addProps) {
            for (const op of transformation.addProps) {
                if (!op.condition || op.condition(element)) {
                    if (addNewProp(j, element.openingElement, op.propName, op.value)) {
                        hasChanges = true;
                        changes.push({ type: "addProp", propName: op.propName, value: op.value });
                    }
                }
            }
        }

        if (transformation.setProps) {
            for (const op of transformation.setProps) {
                if (!op.condition || op.condition(element)) {
                    if (setPropValue(j, element.openingElement, op.propName, op.value)) {
                        hasChanges = true;
                        changes.push({ type: "setProp", propName: op.propName, value: op.value });
                    }
                }
            }
        }

        if (transformation.removeProps) {
            for (const propName of transformation.removeProps) {
                if (removeJSXAttribute(element.openingElement, propName)) {
                    hasChanges = true;
                    changes.push({ type: "removeProp", propName });
                }
            }
        }

        if (transformation.renameProps) {
            for (const [oldName, newName] of Object.entries(transformation.renameProps)) {
                if (renameJSXAttribute(element.openingElement, oldName, newName)) {
                    hasChanges = true;
                    changes.push({ type: "renameProp", propName: oldName, newName });
                }
            }
        }
    }

    return { hasChanges, changes };
}

/**
 * Adds the imports that enum PropValues carry (`namedImportFrom`)
 */
export function ensureEnumImports(j: JSCodeshift, root: Collection<Program>, propValues: PropValue[]): void {
    const requiredImports = new Map<string, Map<string, string>>();

    for (const value of propValues) {
        if (typeof value === "object" && value && value.type === "enum" && value.namedImportFrom) {
            const module = value.namedImportFrom;
            const importName = value.namedImport || value.name;

            let moduleImports = requiredImports.get(module);
            if (!moduleImports) {
                moduleImports = new Map();
                requiredImports.set(module, moduleImports);
            }

            moduleImports.set(importName, importName);
        }
    }

    for (const [module, imports] of requiredImports) {
        addOrUpdateImport(j, root, module, imports);
    }
}
