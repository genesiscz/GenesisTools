/**
 * The block vocabulary and the converter registry.
 *
 * A document is an array of single-key objects. Rendering one block is a table lookup on that
 * key, so adding a block type never edits a switch: register a converter instead. That
 * extension point is the best idea in IonicaBizau/json2md, and it is the reason the CLI can
 * expose `--converter <file.ts>` without the core knowing anything about the CLI.
 */

import { Json2mdError } from "./errors";
import { escapeCell, escapeLinkTitle, escapeUrl } from "./escape";
import { renderGroupedTables, renderTable } from "./table";
import type {
    Badge,
    Block,
    BlockInput,
    CalloutBlock,
    CodeBlock,
    Converter,
    DefinitionEntry,
    DetailsBlock,
    HeadingLevel,
    ImageBlock,
    LinkBlock,
    ListInput,
    MermaidBlock,
    MermaidNode,
    RenderContext,
    RenderOptions,
    Row,
    TableBlockInput,
} from "./types";
import { formatScalar } from "./value";

/** Markdown reserved for the callout syntax GitHub and Obsidian both understand. */
const CALLOUT_LABEL: Record<CalloutBlock["kind"], string> = {
    note: "NOTE",
    abstract: "ABSTRACT",
    info: "INFO",
    todo: "TODO",
    tip: "TIP",
    success: "SUCCESS",
    question: "QUESTION",
    warning: "WARNING",
    failure: "FAILURE",
    danger: "DANGER",
    bug: "BUG",
    example: "EXAMPLE",
    quote: "QUOTE",
};

function asLines(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
}

function prefixLines(value: string, prefix: string): string {
    return value
        .split("\n")
        .map((line) => (line.length === 0 ? prefix.trimEnd() : `${prefix}${line}`))
        .join("\n");
}

function renderHeading(level: HeadingLevel, text: string, ctx: RenderContext): string {
    if (ctx.options.headingStyle === "setext" && level <= 2) {
        const rule = level === 1 ? "=" : "-";

        return `${text}\n${rule.repeat(Math.max(3, [...text].length))}`;
    }

    return `${"#".repeat(level)} ${text}`;
}

function renderList(items: ListInput[], ordered: boolean, ctx: RenderContext, indent = ""): string {
    const indentSize = ctx.options.listIndent ?? 2;
    const lines: string[] = [];
    let counter = 1;

    for (const item of items) {
        const isObject = typeof item === "object" && item !== null;
        const text = isObject ? item.text : formatScalar(item);
        const marker = ordered ? `${counter}.` : (ctx.options.bullet ?? "-");
        const checkbox = isObject && item.checked !== undefined ? `[${item.checked ? "x" : " "}] ` : "";
        // A child list must start at the parent's CONTENT column, which is the marker width plus
        // one: 3 for `1.`, 4 for `10.`. A fixed `listIndent` of 2 left `  1. b` under `1. a`, and
        // CommonMark read it as a sibling, so ordered nesting was lost.
        const childIndent = `${indent}${" ".repeat(Math.max(indentSize, marker.length + 1))}`;
        const body = text.split("\n");

        lines.push(`${indent}${marker} ${checkbox}${body[0] ?? ""}`);

        for (const continuation of body.slice(1)) {
            lines.push(`${indent}${" ".repeat(marker.length + 1)}${continuation}`);
        }

        if (isObject && item.children && item.children.length > 0) {
            lines.push(renderList(item.children, ordered, ctx, childIndent));
        }

        counter += 1;
    }

    return lines.join("\n");
}

function renderCode(input: CodeBlock | string, ctx: RenderContext): string {
    const block: CodeBlock = typeof input === "string" ? { content: input } : input;
    const fenceChar = ctx.options.fence ?? "`";
    const longestRun = Math.max(
        2,
        ...[...block.content.matchAll(new RegExp(`${fenceChar === "`" ? "`" : "~"}+`, "g"))].map((m) => m[0].length)
    );
    const fence = fenceChar.repeat(Math.max(3, longestRun + 1));
    const caption = block.title ? `**${block.title}**\n\n` : "";

    return `${caption}${fence}${block.language ?? ""}\n${block.content.replace(/\n$/, "")}\n${fence}`;
}

function renderDetails(block: DetailsBlock, ctx: RenderContext): string {
    const open = block.open ? " open" : "";
    const body = ctx.render(block.body);

    // GitHub renders markdown inside <details> only when a blank line separates it from the
    // tags, so these blank lines are structural and must not be tidied away.
    return `<details${open}>\n<summary>${block.summary}</summary>\n\n${body}\n\n</details>`;
}

function renderCallout(block: CalloutBlock, ctx: RenderContext): string {
    const fold = block.fold === "closed" ? "-" : block.fold === "open" ? "+" : "";
    const title = block.title ? ` ${block.title}` : "";
    const body = ctx.render(block.body);

    return prefixLines(`[!${CALLOUT_LABEL[block.kind]}]${fold}${title}\n${body}`, "> ");
}

function renderDefinitions(entries: DefinitionEntry[]): string {
    return entries
        .map((entry) => [entry.term, ...entry.definitions.map((definition) => `: ${definition}`)].join("\n"))
        .join("\n\n");
}

function renderLink(block: LinkBlock): string {
    const title = block.tooltip ? ` "${escapeLinkTitle(block.tooltip)}"` : "";

    return `[${block.title ?? block.source}](${escapeUrl(block.source)}${title})`;
}

function renderImage(block: ImageBlock): string {
    const title = block.tooltip ? ` "${escapeLinkTitle(block.tooltip)}"` : "";

    return `![${block.alt ?? ""}](${escapeUrl(block.source)}${title})`;
}

function renderBadges(badges: Badge[]): string {
    return badges
        .map((badge) => {
            const note = badge.note ? ` _${badge.note}_` : "";

            return `**${badge.label}** \`${formatScalar(badge.value)}\`${note}`;
        })
        .join(" · ");
}

function flattenMermaid(nodes: MermaidNode[], parent?: string): Array<{ node: MermaidNode; parent?: string }> {
    const flat: Array<{ node: MermaidNode; parent?: string }> = [];

    for (const node of nodes) {
        flat.push({ node, parent: node.parent ?? parent });

        if (node.children && node.children.length > 0) {
            flat.push(...flattenMermaid(node.children, node.id));
        }
    }

    return flat;
}

/** Mermaid ids may not carry spaces or punctuation, so they are normalised, not quoted. */
function mermaidId(value: string): string {
    return value.replace(/[^A-Za-z0-9_]/g, "_") || "n";
}

function renderMermaid(input: MermaidBlock | string, ctx: RenderContext): string {
    if (typeof input === "string") {
        return renderCode({ content: input, language: "mermaid" }, ctx);
    }

    const direction = input.direction ?? "TD";
    const flat = flattenMermaid(input.nodes);
    const lines = [`graph ${direction}`];

    for (const { node } of flat) {
        const shape = node.shape ?? "[]";
        const open = shape.slice(0, Math.ceil(shape.length / 2));
        const close = shape.slice(Math.ceil(shape.length / 2));
        const label = (node.label ?? node.id).replace(/"/g, "'");

        lines.push(`    ${mermaidId(node.id)}${open}"${label}"${close}`);
    }

    for (const { node, parent } of flat) {
        if (parent !== undefined) {
            lines.push(`    ${mermaidId(parent)} --> ${mermaidId(node.id)}`);
        }
    }

    for (const edge of input.edges ?? []) {
        const label = edge.label ? `|${edge.label}|` : "";
        lines.push(`    ${mermaidId(edge.from)} -->${label} ${mermaidId(edge.to)}`);
    }

    return renderCode({ content: lines.join("\n"), language: "mermaid" }, ctx);
}

function renderTableBlock(block: TableBlockInput, ctx: RenderContext): string {
    const { rows, group, caption, ...options } = block;
    const merged = { ...ctx.options.table, ...options };
    const table = group ? renderGroupedTables(rows as Row[], { ...merged, group }) : renderTable(rows as Row[], merged);

    return caption ? `**${caption}**\n\n${table}` : table;
}

/** The built-in converters, keyed by the block's single key. */
export function builtinConverters(): Record<string, Converter> {
    const converters: Record<string, Converter> = {
        h1: ((text: string, ctx) => renderHeading(1, text, ctx)) as Converter,
        h2: ((text: string, ctx) => renderHeading(2, text, ctx)) as Converter,
        h3: ((text: string, ctx) => renderHeading(3, text, ctx)) as Converter,
        h4: ((text: string, ctx) => renderHeading(4, text, ctx)) as Converter,
        h5: ((text: string, ctx) => renderHeading(5, text, ctx)) as Converter,
        h6: ((text: string, ctx) => renderHeading(6, text, ctx)) as Converter,
        heading: ((data: { level: HeadingLevel; text: string }, ctx) =>
            renderHeading(data.level, data.text, ctx)) as Converter,
        p: ((value: string | string[]) => asLines(value).join("\n\n")) as Converter,
        blockquote: ((value: string | string[]) => prefixLines(asLines(value).join("\n\n"), "> ")) as Converter,
        callout: ((data: CalloutBlock, ctx) => renderCallout(data, ctx)) as Converter,
        ul: ((items: ListInput[], ctx) => renderList(items, false, ctx)) as Converter,
        ol: ((items: ListInput[], ctx) => renderList(items, true, ctx)) as Converter,
        tasks: ((items: ListInput[], ctx) =>
            renderList(
                items.map((item) =>
                    typeof item === "object" && item !== null
                        ? { checked: false, ...item }
                        : { text: formatScalar(item), checked: false }
                ),
                false,
                ctx
            )) as Converter,
        dl: ((entries: DefinitionEntry[]) => renderDefinitions(entries)) as Converter,
        code: ((data: CodeBlock | string, ctx) => renderCode(data, ctx)) as Converter,
        table: ((data: TableBlockInput, ctx) => renderTableBlock(data, ctx)) as Converter,
        link: ((data: LinkBlock) => renderLink(data)) as Converter,
        img: ((data: ImageBlock) => renderImage(data)) as Converter,
        hr: (() => "---") as Converter,
        details: ((data: DetailsBlock, ctx) => renderDetails(data, ctx)) as Converter,
        mermaid: ((data: MermaidBlock | string, ctx) => renderMermaid(data, ctx)) as Converter,
        badges: ((data: Badge[]) => renderBadges(data)) as Converter,
        raw: ((value: string) => value) as Converter,
        nl: (() => "") as Converter,
    };

    return converters;
}

export interface RenderState {
    options: RenderOptions;
    converters: Record<string, Converter>;
}

/**
 * Deepest block nesting before rendering is refused.
 *
 * The block renderer recurses, so an unbounded document would overflow the call stack. That
 * is a live, unfixed bug class in the schema-driven generators (adobe/jsonschema2md#221
 * reports a non-deterministic "Maximum call stack size exceeded"). A named limit turns it
 * into an error a caller can act on.
 */
export const MAX_BLOCK_DEPTH = 100;

/** Renders one block, a nested list of blocks, or a raw markdown string. */
export function renderBlocks(input: BlockInput, state: RenderState, depth = 0): string {
    if (depth > MAX_BLOCK_DEPTH) {
        throw new Json2mdError(
            "MAX_DEPTH_EXCEEDED",
            `Blocks nest deeper than ${MAX_BLOCK_DEPTH}. A document this deep is usually a cycle in the data.`
        );
    }

    const sections = collect(input, state, depth);

    return sections.join("\n\n");
}

function collect(input: BlockInput, state: RenderState, depth: number): string[] {
    if (Array.isArray(input)) {
        return input.flatMap((item) => collect(item, state, depth));
    }

    const rendered = renderOne(input, state, depth);

    // Empty sections are dropped rather than joined. A conditional section returning "" would
    // otherwise leave three blank lines, and two dashes that meet render as a horizontal rule.
    return rendered.trim() === "" ? [] : [rendered];
}

function renderOne(block: Block, state: RenderState, depth: number): string {
    if (typeof block === "string") {
        return block;
    }

    const keys = Object.keys(block);

    if (keys.length === 0) {
        return "";
    }

    if (keys.length > 1) {
        // json2md renders EVERY key on the object, concatenated, which is undocumented and
        // surprising. An ambiguous block is a programming error, so it is refused instead.
        throw new Json2mdError(
            "MULTI_KEY_BLOCK",
            `A block must have exactly one key, got ${keys.join(", ")}. Wrap them in an array instead.`
        );
    }

    const key = keys[0]!;
    const data = (block as Record<string, unknown>)[key];

    if (key === "custom") {
        const custom = data as { type: string; data: unknown };
        const converter = state.converters[custom.type];

        if (!converter) {
            throw new Json2mdError(
                "UNKNOWN_BLOCK",
                `No converter named "${custom.type}". Register one via options.converters.`
            );
        }

        return converter(custom.data as never, contextFor(state, depth));
    }

    const converter = state.converters[key];

    if (!converter) {
        throw new Json2mdError(
            "UNKNOWN_BLOCK",
            `Unknown block "${key}". Known blocks: ${Object.keys(state.converters).sort().join(", ")}.`
        );
    }

    return converter(data as never, contextFor(state, depth));
}

function contextFor(state: RenderState, depth: number): RenderContext {
    return {
        options: {
            bullet: state.options.bullet ?? "-",
            fence: state.options.fence ?? "`",
            emphasis: state.options.emphasis ?? "_",
            headingStyle: state.options.headingStyle ?? "atx",
            ...state.options,
        },
        render: (nested) => renderBlocks(nested, state, depth + 1),
        cell: (value) => escapeCell(formatScalar(value)),
        depth,
    };
}
