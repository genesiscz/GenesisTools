/**
 * Public types for `@genesiscz/utils/json2md`.
 *
 * The core never prints. Every renderer returns a string, so the same functions serve the
 * `tools json2md` CLI, an MCP tool, an HTTP route, and a sibling repo's vendored copy.
 */

/** Column alignment in a GitHub table. */
export type Align = "left" | "center" | "right";

/** What to do when a cell is wider than its column budget. */
export type OverflowStrategy = "wrap" | "truncateStart" | "truncateEnd";

/** What to do with a line break inside a cell. A raw newline would open a new table row. */
export type LineBreakStrategy = "preserve" | "strip" | "truncate";

/** Header casing applied to a column key when no explicit header is given. */
export type HeaderCase =
    | "preserve"
    | "camelCase"
    | "capitalCase"
    | "constantCase"
    | "dotCase"
    | "kebabCase"
    | "noCase"
    | "pascalCase"
    | "pathCase"
    | "sentenceCase"
    | "snakeCase"
    | "titleCase"
    | "trainCase";

/** A measured width for a string. Swap it to make CJK or emoji columns line up differently. */
export type StringLength = (value: string) => number;

/** One record in a table. Keys may be dot paths when the source is nested. */
export type Row = Record<string, unknown>;

/**
 * One table column.
 *
 * `key` addresses the value, `value` replaces that lookup with a computation, and `format`
 * turns whatever was found into display text. A column needs `key` unless it supplies both
 * `value` and `header`, because otherwise it has no name.
 */
export interface ColumnSpec<T = Row> {
    /** Property name or dot path, for example `stats.total`. */
    key: string;
    /** Header text. Without it the key is cased by `headerCase`. */
    header?: string;
    align?: Align;
    /** Exact column width in display cells. Overrides `maxWidth`. */
    width?: number;
    maxWidth?: number;
    overflow?: OverflowStrategy;
    /** Replaces the `key` lookup, so a column can be computed from the whole row. */
    value?: (row: T, index: number) => unknown;
    /** Turns the looked-up value into display text, before escaping. */
    format?: (value: unknown, row: T, index: number) => string;
    /** Text for a `null` or `undefined` value in this column only. */
    empty?: string;
}

/** A column, or the bare key as shorthand for `{ key }`. */
export type ColumnInput<T = Row> = ColumnSpec<T> | string;

/**
 * A named, reusable set of columns.
 *
 * This exists so one row set can be rendered at several column subsets: write the columns
 * once, then render a wide detail table and a narrow progress table from the same rows.
 */
export interface ColumnSet<T = Row> {
    name: string;
    columns: ColumnInput<T>[];
}

export interface TableOptions<T = Row> {
    /** Columns in output order. Without it, the union of keys across rows is used. */
    columns?: ColumnInput<T>[];
    /** Alignment for every column, or one entry per column. A `ColumnSpec.align` wins. */
    align?: Align | Align[];
    /** Casing for headers derived from keys. Default `preserve`. */
    headerCase?: HeaderCase;
    /** Width budget for every column. A `ColumnSpec.maxWidth` wins. */
    maxWidth?: number;
    overflow?: OverflowStrategy;
    /** Default `strip`, because a raw newline in a cell opens a new row. */
    lineBreak?: LineBreakStrategy;
    /** Joins an array cell value. Default `", "`. */
    arraySeparator?: string;
    /** Text for a `null` or `undefined` cell. Default `""`. */
    empty?: string;
    /** Returned instead of a header-only table when there are no rows. Default `_No rows._`. */
    emptyText?: string;
    /** A row key that no column covers. Default `ignore`. */
    unknownKey?: "ignore" | "throw";
    /** Width measurement. Default is ANSI-aware and treats wide glyphs as two cells. */
    stringLength?: StringLength;
    /** Pad cells so the source table lines up in a plain editor. Default `true`. */
    alignDelimiters?: boolean;
    /** Pad the `---` rule to the column width. Default follows `alignDelimiters`. */
    padHeaderSeparator?: boolean;
    /** Transform applied to every cell's display text, after `format` and before escaping. */
    toCellText?: (input: { key: string; value: unknown; row: T; index: number }) => string;
    /** Transform applied to every header. */
    toHeaderTitle?: (input: { key: string; title: string }) => string;
    /** Count ANSI escape sequences toward the width instead of stripping them. */
    countAnsiEscapeCodes?: boolean;
}

/** Splits one row set into several tables, one per group key. */
export interface GroupOptions<T = Row> {
    /** A row key, a dot path, or a function returning the group name. */
    by: string | ((row: T, index: number) => string);
    /** Heading level for each group. Default 3. */
    headingLevel?: number;
    /** Heading text. Default is the group name. */
    heading?: (group: string, rows: T[]) => string;
    /** Group order. Default is first appearance. */
    sort?: "firstSeen" | "alpha" | ((a: string, b: string) => number);
    /** Append the row count to each heading. Default `false`. */
    showCounts?: boolean;
}

/** Obsidian and GitHub share this callout vocabulary. */
export type CalloutKind =
    | "note"
    | "abstract"
    | "info"
    | "todo"
    | "tip"
    | "success"
    | "question"
    | "warning"
    | "failure"
    | "danger"
    | "bug"
    | "example"
    | "quote";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface ListItemObject {
    text: string;
    children?: ListInput[];
    /** Renders a task list item when set. */
    checked?: boolean;
}

export type ListInput = string | number | boolean | ListItemObject;

export interface CodeBlock {
    content: string;
    language?: string;
    /** Caption rendered above the fence. */
    title?: string;
}

export interface LinkBlock {
    source: string;
    title?: string;
    /** Hover title, the second argument in `[a](b "c")`. */
    tooltip?: string;
}

export interface ImageBlock {
    source: string;
    alt?: string;
    tooltip?: string;
}

export interface DetailsBlock {
    summary: string;
    body: BlockInput;
    /** Emits `<details open>`. */
    open?: boolean;
}

export interface CalloutBlock {
    kind: CalloutKind;
    body: BlockInput;
    title?: string;
    /** Obsidian foldable callout: `+` open, `-` collapsed. */
    fold?: "open" | "closed";
}

export interface DefinitionEntry {
    term: string;
    definitions: string[];
}

/** A text badge rendered inline, with no network call and no image. */
export interface Badge {
    label: string;
    value: string | number;
    /** Optional third segment, for example a unit. */
    note?: string;
}

/** A node in a generated mermaid graph. */
export interface MermaidNode {
    id: string;
    label?: string;
    parent?: string;
    children?: MermaidNode[];
    /** Free-form shape override, for example `[(db)]`. */
    shape?: string;
}

export interface MermaidBlock {
    /** Default `graph TD`. */
    direction?: "TD" | "TB" | "BT" | "LR" | "RL";
    nodes: MermaidNode[];
    /** Extra edges beyond the parent links. */
    edges?: Array<{ from: string; to: string; label?: string }>;
}

export interface TableBlockInput<T = Row> extends TableOptions<T> {
    rows: T[];
    /** Renders one table per group, each under its own heading. */
    group?: GroupOptions<T>;
    /** Caption rendered above the table. */
    caption?: string;
}

/**
 * The block vocabulary.
 *
 * A bare string passes through as raw markdown. Every other block is a single-key object, so
 * a document reads as data and a custom converter can add a key without changing this union.
 */
export type Block =
    | string
    | { h1: string }
    | { h2: string }
    | { h3: string }
    | { h4: string }
    | { h5: string }
    | { h6: string }
    | { heading: { level: HeadingLevel; text: string } }
    | { p: string | string[] }
    | { blockquote: string | string[] }
    | { callout: CalloutBlock }
    | { ul: ListInput[] }
    | { ol: ListInput[] }
    | { tasks: ListInput[] }
    | { dl: DefinitionEntry[] }
    | { code: CodeBlock | string }
    | { table: TableBlockInput }
    | { link: LinkBlock }
    | { img: ImageBlock }
    | { hr: true }
    | { details: DetailsBlock }
    | { mermaid: MermaidBlock | string }
    | { badges: Badge[] }
    | { raw: string }
    | { nl: true }
    | { custom: { type: string; data: unknown } };

/** One block, a list of blocks, or a nested list. Nested lists are flattened. */
export type BlockInput = Block | BlockInput[];

/** A converter turns one block key into markdown. Register one to extend the vocabulary. */
export type Converter = (data: never, ctx: RenderContext) => string;

/** Everything a converter needs, without reaching back into module state. */
export interface RenderContext {
    options: Required<Pick<RenderOptions, "bullet" | "fence" | "emphasis" | "headingStyle">> & RenderOptions;
    /** Renders nested blocks, so a converter can contain other blocks. */
    render: (input: BlockInput) => string;
    /** Escapes one table cell with the active options. */
    cell: (value: unknown) => string;
    /** Current nesting depth, starting at 0. */
    depth: number;
}

export type Engine = "string" | "mdast";

export interface RenderOptions {
    /** Renderer backend. `string` is the default and needs no extra packages. */
    engine?: Engine;
    /** Unordered list marker. Default `-`. */
    bullet?: "-" | "*" | "+";
    /** Fence character for code blocks. Default a backtick. */
    fence?: "`" | "~";
    /** Emphasis marker. Default `_`. */
    emphasis?: "_" | "*";
    /** Default `atx`, meaning `## Title`. */
    headingStyle?: "atx" | "setext";
    /** Spaces per nesting level in a list. Default 2. */
    listIndent?: number;
    /** Line ending. Default `\n`. */
    lineEnding?: "\n" | "\r\n";
    /** Table defaults, overridable per table block. */
    table?: TableOptions;
    /** Custom converters keyed by block key, merged over the built-ins. */
    converters?: Record<string, Converter>;
    /** End the document with exactly one newline. Default `true`. */
    trailingNewline?: boolean;
}
