/**
 * `@genesiscz/utils/json2md` — JSON to Markdown.
 *
 * Two entry points, because there are two jobs:
 *  - `json2md(blocks)` renders a document you described, block by block;
 *  - `jsonToMarkdown(value)` renders a document it worked out from the data.
 *
 * Neither prints. The CLI at `src/json2md/` and any other door own all output.
 */

import { type AutoOptions, jsonToBlocks } from "./auto";
import { builtinConverters, type RenderState, renderBlocks } from "./blocks";
import { joinSections, type ProvenanceInput, renderProvenance, renderToc, type TocOptions } from "./document";
import { type FrontmatterFormat, renderFrontmatter } from "./frontmatter";
import type { BlockInput, Converter, RenderOptions } from "./types";

export type { AutoOptions, Shape } from "./auto";
export { detectShape, jsonToBlocks } from "./auto";
export { builtinConverters, MAX_BLOCK_DEPTH, renderBlocks } from "./blocks";
// `./document-file` is deliberately NOT re-exported here: it imports this module, and a cycle
// through the package entry point is fragile. Import it directly:
//   import { defineDocument } from "@genesiscz/utils/json2md/document-file";
export type { ProvenanceInput, TocOptions } from "./document";
export { joinSections, renderProvenance, renderToc, slugifyHeading } from "./document";
export type { Json2mdErrorCode, Json2mdErrorOptions } from "./errors";
export { Json2mdError, pointerOf } from "./errors";
export {
    displayWidth,
    escapeCell,
    escapeInline,
    escapeLinkTitle,
    escapeUrl,
    padToWidth,
    stripAnsi,
    truncateToWidth,
} from "./escape";
export type { FrontmatterFormat } from "./frontmatter";
export { renderFrontmatter, splitFrontmatter, toYaml } from "./frontmatter";
export type { CheckResult, Stamp, Verdict } from "./integrity";
export { checkMarkdown, hashData, hashText, STAMP_VERSION, stampMarkdown, stripStamp } from "./integrity";
export {
    defineColumns,
    inferColumns,
    omitColumns,
    pickColumns,
    renderGroupedTables,
    renderTable,
    wrapToWidth,
} from "./table";
export * from "./types";
export {
    applyHeaderCase,
    count,
    formatScalar,
    getPath,
    localTimestamp,
    percent,
    ratioLine,
    splitWords,
    stableStringify,
} from "./value";

/** Extras that wrap a rendered body, shared by both entry points. */
export interface DocumentOptions extends RenderOptions {
    /** An H1 placed above everything except the front matter. */
    title?: string;
    /** Metadata rendered as a front-matter block. */
    frontmatter?: Record<string, unknown>;
    frontmatterFormat?: FrontmatterFormat;
    /** A provenance header: when, from what commit, covering what, and how to regenerate. */
    provenance?: ProvenanceInput;
    /** Insert a table of contents built from the rendered body. */
    toc?: boolean | TocOptions;
}

function buildState(options: RenderOptions): RenderState {
    return {
        options,
        converters: { ...builtinConverters(), ...(options.converters ?? {}) },
    };
}

/** Wraps a rendered body in the title, front matter, provenance header and contents list. */
function wrapDocument(body: string, options: DocumentOptions): string {
    const lineEnding = options.lineEnding ?? "\n";
    const toc = options.toc ? renderToc(body, typeof options.toc === "object" ? options.toc : {}) : "";

    const document = joinSections(
        [
            options.frontmatter ? renderFrontmatter(options.frontmatter, options.frontmatterFormat ?? "yaml") : "",
            options.title ? `# ${options.title}` : "",
            options.provenance ? renderProvenance(options.provenance) : "",
            toc,
            body,
        ],
        lineEnding
    );

    if (options.trailingNewline === false) {
        return document;
    }

    return `${document}${lineEnding}`;
}

/**
 * Renders a block document.
 *
 * A block is a single-key object such as `{ h2: "Results" }` or `{ table: { rows } }`. A bare
 * string passes through as raw markdown. Arrays nest freely and are flattened.
 *
 * @throws when a block carries more than one key, or names a converter that is not registered.
 */
export function json2md(input: BlockInput, options: DocumentOptions = {}): string {
    const body = renderBlocks(input, buildState(options));

    return wrapDocument(body, options);
}

export interface ConvertOptions extends DocumentOptions, AutoOptions {}

/**
 * Renders parsed JSON with no template, choosing the shape per branch.
 *
 * A uniform array of flat objects becomes a table, an array of scalars becomes a list, a flat
 * object of short values becomes a definition list, and anything past `collapseDepth` is
 * wrapped in `<details>`.
 */
export function jsonToMarkdown(value: unknown, options: ConvertOptions = {}): string {
    const blocks = jsonToBlocks(value, options);
    const body = renderBlocks(blocks, buildState(options));

    return wrapDocument(body, options);
}

/**
 * Registers a converter on an options object, returning a new one.
 *
 * Mirrors `json2md.converters.x = fn` from IonicaBizau/json2md, without the module-level
 * mutation that makes two callers in one process fight over the same registry.
 */
export function withConverter(options: RenderOptions, type: string, converter: Converter): RenderOptions {
    return { ...options, converters: { ...(options.converters ?? {}), [type]: converter } };
}
