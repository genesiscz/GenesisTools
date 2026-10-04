import type { Collection, JSCodeshift, JSXElement, Program } from "jscodeshift";
import type * as ts from "typescript";
import type { ComponentNode } from "./ComponentNode";
import type { r } from "./rule-builders";

export interface TransformerResult {
    file: ts.SourceFile;
    modified: boolean;
}

export interface PropertyConfig {
    component: string;
    property: string;
    message?: string;
}

export interface RulePredicateCtx {
    node: ComponentNode;
    jsx: JSXElement | null;
    filePath: string;
    fromModule?: string;
    componentName?: string;
    j: JSCodeshift;
    root: Collection<Program>;
    isImportedFrom: (modules: string[]) => boolean;
    hasProp: (name: string) => boolean;
    getPropValue: (name: string) => unknown;
    propEquals: (name: string, value: unknown) => boolean;
    kind: ComponentNode["kind"];
}

export interface ComponentRule {
    for: string;
    when: (ctx: RulePredicateCtx) => boolean;
    do: ReturnType<(typeof r)[keyof typeof r]>[];
}

export interface RenameConfig {
    component: string;
    oldProperty: string;
    newProperty: string;
    valueMap?: Record<string, string>;
}

export type SpecialTransformFunction = (j: JSCodeshift, element: JSXElement) => JSXElement;

/** What a transform reports about the changes it made, one call per change. */
export interface AutoLogger {
    importChange: (file: string, mod: string, nameOrKind: string, action: string, details?: unknown) => void;
    componentRename: (file: string, fromName: string, toName: string) => void;
    propChange: (file: string, component: string, prop: string, action: string, details?: unknown) => void;
    typeChange: (file: string, fromType: string, action: string, toType: string) => void;
    warning: (file: string, message: string) => void;
    debug: (file: string, message: string) => void;
}

export interface ImportManager {
    scan: () => void;
    ensureImport: (module: string, importedName: string, localName?: string) => { localName: string };
    removeImport: (module: string, importedOrLocalName: string) => void;
    aliasLocalName: (local: string, alias: string) => void;
    ensureEnumImport: (opts: { name: string; module: string }) => void;
    ensureTypeImport: (opts: { name: string; module: string }) => void;
    resolveComponentRename: (opts: {
        from: { name: string; module?: string };
        to: { name: string; module?: string };
    }) => {
        useName: string;
        importActions: Array<{
            type: "add" | "remove" | "alias";
            module: string;
            importedName: string;
            localName: string;
        }>;
    };
    resolveIdentifierRename?: (from: { name: string; module?: string }, to: { name: string; module?: string }) => void;
    resolveImportRename?: (
        from: { module: string; importedName: string },
        to?: { module: string; importedName?: string }
    ) => void;
    resolveModuleRename?: (fromModule: string, toModule: string) => void;
    resolveEnumRename?: (from: { name: string; module?: string }, to: { name: string; module?: string }) => void;
    resolveHookRename?: (from: { name: string; module?: string }, to: { name: string; module?: string }) => void;
    resolveTypeRename?: (from: { name: string; module?: string }, to: { name: string; module?: string }) => void;
    consolidate: () => void;
    applyChanges: () => void;
}

export interface TransformContext {
    filePath: string;
    j: JSCodeshift;
    root: Collection<Program>;
    importManager: ImportManager;
    logger: AutoLogger;
    options?: Record<string, unknown>;
}

// ============================================================================
// PROP VALUE TYPES
// ============================================================================

/**
 * The value a transform sets on a JSX prop. A bare string or boolean is the short form; `null` removes the prop.
 */
export type PropValue =
    | string
    | boolean
    | {
          type: "string";
          value: string;
      }
    | {
          type: "boolean";
          value: boolean;
      }
    | {
          type: "enum";
          /** Enum name, e.g. `SizeEnum` */
          name: string;
          /** Enum member, e.g. `LARGE` */
          value: string;
          /** Import name if different from `name` */
          namedImport?: string;
          /** Module to import the enum from */
          namedImportFrom?: string;
      }
    | {
          type: "identifier";
          /** A variable reference */
          name: string;
      }
    | {
          type: "expression";
          /** Raw expression source */
          code: string;
      }
    | null;

// ============================================================================
// COMPONENT TRANSFORMATION TYPES
// ============================================================================

/** Sets or adds one prop, optionally only when `condition` holds for the element. */
export interface PropOperation {
    propName: string;
    value: PropValue;
    condition?: (element: JSXElement) => boolean;
}

/** A transformation applied only to elements that satisfy `condition`. */
export interface ConditionalTransformation {
    condition: (element: JSXElement) => boolean;
    renameTo?: string;
    addProps?: PropOperation[];
    setProps?: PropOperation[];
    removeProps?: string[];
    renameProps?: Record<string, string>;
}

/** What a component transformation changed. */
export interface ComponentTransformationResult {
    changed: boolean;
    newName?: string;
    importFrom: string;
    removedProps: string[];
    addedProps: string[];
    renamedProps?: Record<string, string>;
    /** Every import the transformation needs added */
    requiredImports?: Array<{ name: string; module: string }>;
}

export type JSXChildNode = NonNullable<JSXElement["children"]>[number];

/** The declarative description `transformJSXComponent` applies to one element. */
export interface EnhancedComponentTransformation {
    renameTo?: string;
    removeProps?: string[];
    commentProps?: string[];
    renameProps?: Record<string, string>;
    transformProps?: Record<string, (value: string | undefined, j: JSCodeshift) => string | undefined>;
    addProps?: Record<string, string>;
    ensurePropsAreBoolean?: string[];
    transformChildren?: (children: JSXChildNode[], j: JSCodeshift, element: JSXElement) => JSXChildNode[];
    movePropsToNested?: Record<string, { targetProp: string; nestedProp: string }>;
    appendAfter?: unknown[];

    /** Props to set: added when missing, updated when present */
    setProps?: PropOperation[];
    /** Props to add only when missing */
    addNewProps?: PropOperation[];
    conditionalTransformations?: ConditionalTransformation[];
    /** Prop values to turn into specific PropValue shapes */
    transformToProp?: Record<string, PropValue>;
}
