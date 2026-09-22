/**
 * Automatic shape detection: JSON in, a block document out, with no template.
 *
 * This is the piece the surveyed ecosystem does not have. tablemark renders a table because
 * you called a table function. jsonschema2md collapses children because a schema told it the
 * nesting. Here the data decides: a uniform array of flat objects becomes a table, an array
 * of scalars becomes a list, a flat object of short scalars becomes a definition list, and
 * anything past the collapse depth is wrapped in `<details>` so a deep document stays
 * readable instead of turning into a wall of nested bullets.
 */

import { Json2mdError, pointerOf } from "./errors";
import { escapeInline } from "./escape";
import type { Block, DefinitionEntry, HeaderCase, HeadingLevel, ListInput, Row, TableOptions } from "./types";
import { applyHeaderCase, formatScalar } from "./value";

export type Shape =
    | "empty"
    | "scalar"
    | "text"
    | "code"
    | "scalar-list"
    | "table"
    | "object-list"
    | "definition-list"
    | "key-value-table"
    | "sections";

export interface AutoOptions {
    /** Heading level for the outermost sections. Default 2. */
    headingLevel?: HeadingLevel;
    /** Nesting depth past which a branch is wrapped in `<details>`. Default 3. `0` disables. */
    collapseDepth?: number;
    /** Deepest level that still gets a heading. Below it, branches become nested lists. */
    maxHeadingDepth?: number;
    /** Fewest rows before an array of objects is worth a table. Default 1. */
    tableMinRows?: number;
    /**
     * Fraction of keys that must be shared across rows before a table is used. Default 0.6.
     * Below it the array renders as sections, because a sparse table is mostly empty cells.
     */
    tableUniformity?: number;
    /** Longest scalar that still fits a definition list. Default 80. */
    definitionMaxLength?: number;
    /** Casing applied to keys used as headings, terms and column headers. Default `preserve`. */
    keyCase?: HeaderCase;
    /** A string longer than this becomes a fenced block instead of a paragraph. Default 0, off. */
    codeThreshold?: number;
    /** Key whose value titles a section when an array of objects renders as sections. */
    titleKey?: string;
    /** Emit a mermaid graph when the value looks like a tree. Default `false`. */
    mermaidForTrees?: boolean;
    /**
     * Escape markdown and HTML in string VALUES. Default `true`.
     *
     * Data is not a document author. Without this, a value of `# Heading` becomes a heading
     * and `<img onerror=…>` reaches the renderer as HTML. Turn it off only when the data is
     * known to contain markdown you want rendered.
     */
    escapeValues?: boolean;
    /**
     * Render `null`, `""`, `[]` and `{}` as distinct literal tokens instead of a blank.
     * Default `false`. With it on, an empty cell means "the field was absent", which no other
     * surveyed library distinguishes.
     */
    emptyTokens?: boolean;
    /** Deepest nesting before rendering is refused. Default 64. */
    maxDepth?: number;
}

interface Resolved extends Required<Omit<AutoOptions, "titleKey">> {
    titleKey?: string;
}

function resolve(options: AutoOptions): Resolved {
    return {
        headingLevel: options.headingLevel ?? 2,
        collapseDepth: options.collapseDepth ?? 3,
        maxHeadingDepth: options.maxHeadingDepth ?? 4,
        tableMinRows: options.tableMinRows ?? 1,
        tableUniformity: options.tableUniformity ?? 0.6,
        definitionMaxLength: options.definitionMaxLength ?? 80,
        keyCase: options.keyCase ?? "preserve",
        codeThreshold: options.codeThreshold ?? 0,
        mermaidForTrees: options.mermaidForTrees ?? false,
        escapeValues: options.escapeValues ?? true,
        emptyTokens: options.emptyTokens ?? false,
        maxDepth: options.maxDepth ?? 64,
        titleKey: options.titleKey,
    };
}

/** An empty value rendered as a visible token, so "blank" and "absent" stay different. */
function emptyToken(value: unknown): string | null {
    if (value === null) {
        return "`null`";
    }

    if (value === undefined) {
        return "`undefined`";
    }

    if (value === "") {
        return '`""`';
    }

    if (Array.isArray(value) && value.length === 0) {
        return "`[]`";
    }

    if (isPlainObject(value) && Object.keys(value).length === 0) {
        return "`{}`";
    }

    return null;
}

/**
 * Display text for one data value.
 *
 * An empty token is already a code span, so it is never escaped again; escaping it would
 * show the backticks instead of hiding them.
 */
function text(value: unknown, opts: Resolved): string {
    if (opts.emptyTokens) {
        const token = emptyToken(value);

        if (token !== null) {
            return token;
        }
    }

    const rendered = formatScalar(value);

    return opts.escapeValues ? escapeInline(rendered) : rendered;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function isScalar(value: unknown): boolean {
    return value === null || value === undefined || typeof value !== "object" || value instanceof Date;
}

/** How uniform an array of objects is: shared keys divided by distinct keys. */
function uniformity(rows: ReadonlyArray<Record<string, unknown>>): number {
    if (rows.length === 0) {
        return 0;
    }

    const counts = new Map<string, number>();

    for (const row of rows) {
        for (const key of Object.keys(row)) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }

    if (counts.size === 0) {
        return 0;
    }

    let shared = 0;

    for (const occurrences of counts.values()) {
        shared += occurrences / rows.length;
    }

    return shared / counts.size;
}

/** True when every value in the object is a scalar, so the object fits one table row. */
function isFlat(value: Record<string, unknown>): boolean {
    return Object.values(value).every(isScalar);
}

/** Decides how a value should be rendered. Exported so a caller can override one branch. */
export function detectShape(value: unknown, options: AutoOptions = {}): Shape {
    const opts = resolve(options);

    if (value === null || value === undefined) {
        return "empty";
    }

    if (typeof value === "string") {
        if (opts.codeThreshold > 0 && value.length > opts.codeThreshold) {
            return "code";
        }

        return value.includes("\n") ? "text" : "scalar";
    }

    if (isScalar(value)) {
        return "scalar";
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "empty";
        }

        if (value.every(isScalar)) {
            return "scalar-list";
        }

        const objects = value.filter(isPlainObject);

        if (objects.length === value.length && value.length >= opts.tableMinRows) {
            const flatEnough = objects.every(isFlat);

            if (flatEnough && uniformity(objects) >= opts.tableUniformity) {
                return "table";
            }
        }

        return "object-list";
    }

    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length === 0) {
        return "empty";
    }

    if (isFlat(value as Record<string, unknown>)) {
        const longest = Math.max(...entries.map(([, item]) => formatScalar(item).length));

        return longest <= opts.definitionMaxLength ? "definition-list" : "key-value-table";
    }

    return "sections";
}

/** True when the value looks like a tree that a mermaid graph would read better than a list. */
function looksLikeTree(value: unknown): boolean {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }

    const objects = value.filter(isPlainObject);

    if (objects.length !== value.length) {
        return false;
    }

    const hasId = objects.every((row) => "id" in row);
    const hasParent = objects.some((row) => "parent" in row || "parentId" in row);
    const hasChildren = objects.some((row) => Array.isArray(row.children));

    return hasId && (hasParent || hasChildren);
}

function toListItems(values: readonly unknown[], opts: Resolved): ListInput[] {
    return values.map((item) => text(item, opts));
}

function definitionEntries(value: Record<string, unknown>, opts: Resolved): DefinitionEntry[] {
    return Object.entries(value).map(([key, item]) => ({
        term: applyHeaderCase(key, opts.keyCase),
        definitions: [text(item, opts)],
    }));
}

function keyValueRows(value: Record<string, unknown>, opts: Resolved): Row[] {
    return Object.entries(value).map(([key, item]) => ({
        Field: applyHeaderCase(key, opts.keyCase),
        Value: text(item, opts),
    }));
}

/** Table options for the auto path: data-derived cells go through the same escaping. */
function autoTableOptions(opts: Resolved): TableOptions {
    return {
        headerCase: opts.keyCase,
        toCellText: ({ value }) => text(value, opts),
    };
}

function headingAt(depth: number, base: HeadingLevel): HeadingLevel {
    return Math.min(6, base + depth) as HeadingLevel;
}

/**
 * Emits one titled section.
 *
 * Past `collapseDepth` the `<details>` summary REPLACES the heading rather than joining it.
 * Emitting both puts the same words on screen twice and leaves a heading that the contents
 * list links to but that the reader cannot see until they expand the block.
 *
 * @param level 0-based nesting level of this section, counted from the outermost one.
 */
function section(title: string, level: number, body: Block[], opts: Resolved): Block[] {
    if (body.length === 0) {
        return [];
    }

    if (opts.collapseDepth > 0 && level >= opts.collapseDepth) {
        return [{ details: { summary: title, body } }];
    }

    if (level >= opts.maxHeadingDepth) {
        return [{ p: `**${title}**` }, ...body];
    }

    return [{ heading: { level: headingAt(level, opts.headingLevel), text: title } }, ...body];
}

/**
 * Converts any JSON value into blocks.
 *
 * @param value  the parsed JSON
 * @param options shape-detection thresholds
 */
export function jsonToBlocks(value: unknown, options: AutoOptions = {}): Block[] {
    const opts = resolve(options);

    return convert(value, opts, 0, undefined, new Set(), []);
}

/**
 * @param seen objects on the current path, so a cycle is reported instead of recursing until
 *             the call stack overflows.
 * @param path segments for the JSON Pointer carried by any error thrown from here.
 */
function convert(
    value: unknown,
    opts: Resolved,
    depth: number,
    label: string | undefined,
    seen: Set<object>,
    path: Array<string | number>
): Block[] {
    if (depth > opts.maxDepth) {
        throw new Json2mdError("MAX_DEPTH_EXCEEDED", `Value nests deeper than maxDepth (${opts.maxDepth})`, {
            pointer: pointerOf(path),
        });
    }

    if (value !== null && typeof value === "object") {
        if (seen.has(value)) {
            throw new Json2mdError("CYCLIC_REFERENCE", "Value contains a cycle, so it cannot be rendered", {
                pointer: pointerOf(path),
            });
        }

        seen.add(value);

        try {
            return convertNode(value, opts, depth, label, seen, path);
        } finally {
            // Removed on the way out, so the same object appearing twice SIDE BY SIDE is fine.
            // Only an object containing itself is a cycle.
            seen.delete(value);
        }
    }

    return convertNode(value, opts, depth, label, seen, path);
}

function convertNode(
    value: unknown,
    opts: Resolved,
    depth: number,
    label: string | undefined,
    seen: Set<object>,
    path: Array<string | number>
): Block[] {
    const shape = detectShape(value, opts);

    switch (shape) {
        case "empty":
            return [
                {
                    p: opts.emptyTokens
                        ? (emptyToken(value) ?? "_None._")
                        : value === null || value === undefined
                          ? "_None._"
                          : "_Empty._",
                },
            ];

        case "scalar":
            return [{ p: text(value, opts) }];

        case "text":
            return [
                {
                    p: String(value)
                        .split(/\n{2,}/)
                        .map((part) => (opts.escapeValues ? escapeInline(part) : part)),
                },
            ];

        case "code":
            return [{ code: { content: String(value) } }];

        case "scalar-list":
            return [{ ul: toListItems(value as unknown[], opts) }];

        case "table": {
            const rows = value as Row[];

            if (opts.mermaidForTrees && looksLikeTree(rows)) {
                return [
                    {
                        mermaid: {
                            // `Row` is `object` so an interface can be a row; these fields are
                            // read by name, and `looksLikeTree` has already checked they exist.
                            nodes: (rows as Array<Record<string, unknown>>).map((row) => ({
                                id: String(row.id),
                                label: String(row.name ?? row.title ?? row.label ?? row.id),
                                parent:
                                    row.parent === undefined
                                        ? row.parentId === undefined
                                            ? undefined
                                            : String(row.parentId)
                                        : String(row.parent),
                            })),
                        },
                    },
                ];
            }

            return [{ table: { rows, ...autoTableOptions(opts) } }];
        }

        case "object-list":
            return convertObjectList(value as unknown[], opts, depth, label, seen, path);

        case "definition-list":
            return [{ dl: definitionEntries(value as Record<string, unknown>, opts) }];

        case "key-value-table":
            return [
                {
                    table: {
                        rows: keyValueRows(value as Record<string, unknown>, opts),
                        columns: ["Field", "Value"],
                    },
                },
            ];

        case "sections":
            return convertSections(value as Record<string, unknown>, opts, depth, seen, path);

        default:
            return [{ p: text(value, opts) }];
    }
}

function convertObjectList(
    items: readonly unknown[],
    opts: Resolved,
    depth: number,
    label: string | undefined,
    seen: Set<object>,
    path: Array<string | number>
): Block[] {
    const blocks: Block[] = [];

    items.forEach((item, index) => {
        const title =
            opts.titleKey && isPlainObject(item) && item[opts.titleKey] !== undefined
                ? text(item[opts.titleKey], opts)
                : `${label ?? "Item"} ${index + 1}`;

        blocks.push(...section(title, depth, convert(item, opts, depth + 1, title, seen, [...path, index]), opts));
    });

    return blocks;
}

function convertSections(
    value: Record<string, unknown>,
    opts: Resolved,
    depth: number,
    seen: Set<object>,
    path: Array<string | number>
): Block[] {
    const blocks: Block[] = [];
    const scalars: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
        if (isScalar(item)) {
            scalars[key] = item;
        }
    }

    // The object's own scalar fields render first, as a summary above its sub-sections.
    if (Object.keys(scalars).length > 0) {
        blocks.push(...convertNode(scalars, opts, depth, undefined, seen, path));
    }

    for (const [key, item] of Object.entries(value)) {
        if (isScalar(item)) {
            continue;
        }

        const title = applyHeaderCase(key, opts.keyCase);

        blocks.push(...section(title, depth, convert(item, opts, depth + 1, title, seen, [...path, key]), opts));
    }

    return blocks;
}
