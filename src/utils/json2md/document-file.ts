/**
 * The three-file pattern: `X.json` holds the data, `X.ts` describes the document, `X.md` is
 * the generated output.
 *
 * The `.ts` is the only place a shape decision lives, so regenerating is always safe and
 * always reproducible. `X.md` carries a stamp, so a hand edit is caught instead of silently
 * overwritten. See `integrity.ts` for why the stamp is the only thing that can tell a hand
 * edit from a data change.
 */

import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import TOML from "@iarna/toml";
import { Json2mdError } from "./errors";
import { type DocumentOptions, json2md } from "./index";
import { type CheckResult, checkMarkdown, hashData, stampMarkdown, stripStamp } from "./integrity";
import type { BlockInput } from "./types";
import { localTimestamp } from "./value";

export interface DocumentDefinition<T = unknown> {
    /** Data file, relative to the `.ts` that declares it. */
    data: string;
    /** Output markdown. Defaults to the `.ts` path with a `.md` extension. */
    out?: string;
    /** Turns parsed data into blocks. This is the whole document description. */
    render: (data: T) => BlockInput;
    /** Title, front matter, provenance header and contents list. */
    options?: DocumentOptions;
    /** The command a reader should run to regenerate. Defaults to `tools json2md build <file>`. */
    command?: string;
    /** Skip the stamp. Only for a document that a person is expected to keep editing. */
    unstamped?: boolean;
}

const MARKER = Symbol.for("genesiscz.json2md.document");

export type DefinedDocument<T = unknown> = DocumentDefinition<T> & { [MARKER]: true };

/**
 * Declares a generated document.
 *
 * ```ts
 * export default defineDocument<Registry>({
 *     data: "./ConversionRegistry.json",
 *     options: { title: "Conversion registry" },
 *     render: (data) => [{ table: { rows: data.items } }],
 * });
 * ```
 */
export function defineDocument<T = unknown>(definition: DocumentDefinition<T>): DefinedDocument<T> {
    // 🛑 A document module is loaded by dynamic import, so TypeScript never sees it: nothing
    // typechecks the object below at the moment it matters. Validating here rather than in
    // `buildDocument` means `bun Doc.ts` reports the mistake too, not only the CLI.
    if (typeof definition.data !== "string" || definition.data.trim() === "") {
        throw new Json2mdError(
            "INVALID_DEFINITION",
            `\`data\` must be a path to the JSON file, for example "./Report.json". Got ${describe(definition.data)}.`,
            { pointer: "/data" }
        );
    }

    if (typeof definition.render !== "function") {
        throw new Json2mdError(
            "INVALID_DEFINITION",
            `\`render\` must be a function taking the parsed data and returning blocks. Got ${describe(definition.render)}.`,
            { pointer: "/render" }
        );
    }

    return { ...definition, [MARKER]: true };
}

/** Names what the caller actually passed, so the message points at their mistake. */
function describe(value: unknown): string {
    if (Array.isArray(value)) {
        return "an array — pass the path to the file that holds it, not the data itself";
    }

    if (value === undefined) {
        return "nothing";
    }

    return `a ${typeof value}`;
}

export function isDefinedDocument(value: unknown): value is DefinedDocument {
    return typeof value === "object" && value !== null && MARKER in value;
}

function resolveFrom(baseDir: string, path: string): string {
    return isAbsolute(path) ? path : resolve(baseDir, path);
}

/**
 * Output path for a definition: explicit `out`, else the module path with `.md`.
 *
 * Takes only the field it reads. A whole `DocumentDefinition<T>` would not be assignable to
 * `DocumentDefinition<unknown>`, because `render` makes the type contravariant in `T`.
 */
export function outputPathFor(modulePath: string, definition: Pick<DocumentDefinition, "out">): string {
    if (definition.out) {
        return resolveFrom(dirname(modulePath), definition.out);
    }

    return modulePath.replace(/\.[cm]?tsx?$/, "") + ".md";
}

async function readData(path: string): Promise<unknown> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        throw new Error(`json2md: data file not found: ${path}`);
    }

    const text = await file.text();

    if (path.endsWith(".toml")) {
        return TOML.parse(text);
    }

    if (path.endsWith(".jsonl") || path.endsWith(".ndjson")) {
        return text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => SafeJSON.parse(line, { strict: true }));
    }

    return SafeJSON.parse(text);
}

export interface BuildResult {
    /** The finished document, stamp included unless the definition opted out. */
    markdown: string;
    /** The same document without its stamp, for comparison. */
    body: string;
    outPath: string;
    dataPath: string;
    sourceHash: string;
    data: unknown;
}

export interface BuildOverrides {
    /**
     * Pins the generated-at timestamp instead of using now.
     *
     * Regenerating must be idempotent. Without this, the provenance header and the stamp both
     * carry a fresh time on every run, so an unchanged document is reported stale a minute
     * later and shows up as a diff in every commit.
     */
    generatedAt?: string;
}

/**
 * Renders a definition without writing anything.
 *
 * @param modulePath absolute path of the `.ts` that declared the document, used to resolve
 *                   the data and output paths and to record the generator in the stamp.
 */
export async function buildDocument<T>(
    modulePath: string,
    definition: DocumentDefinition<T>,
    overrides: BuildOverrides = {}
): Promise<BuildResult> {
    const baseDir = dirname(modulePath);
    const dataPath = resolveFrom(baseDir, definition.data);
    const data = await readData(dataPath);
    const outPath = outputPathFor(modulePath, definition);
    const sourceHash = hashData(data);
    const generated = overrides.generatedAt ?? localTimestamp();

    const options = definition.options?.provenance
        ? {
              ...definition.options,
              provenance: { generated, ...definition.options.provenance },
          }
        : (definition.options ?? {});

    // The data comes off disk as `unknown`; the definition declares the shape it expects.
    const body = json2md(definition.render(data as T), options);

    if (definition.unstamped) {
        return { markdown: body, body, outPath, dataPath, sourceHash, data };
    }

    // 🛑 The recorded command must not depend on where the generator happened to be run from.
    // A `relative(process.cwd(), …)` path is written into a DURABLE file that another person,
    // in another directory, is meant to be able to run: building a vault note from the repo
    // recorded `tools json2md build ../../../../../…`, which works from exactly one place.
    // A path inside the current directory stays short; anything outside it goes in absolute.
    const fromCwd = relative(process.cwd(), modulePath);
    const portable = fromCwd !== "" && !fromCwd.startsWith("..") && !isAbsolute(fromCwd) ? fromCwd : modulePath;
    const command = definition.command ?? `tools json2md build ${portable}`;
    const markdown = stampMarkdown(body, {
        source: sourceHash,
        generator: relative(dirname(outPath), modulePath) || modulePath,
        generated,
        command,
    });

    return { markdown, body, outPath, dataPath, sourceHash, data };
}

export type WriteOutcome = "written" | "unchanged" | "refused";

export interface WriteResult extends BuildResult {
    outcome: WriteOutcome;
    check: CheckResult | null;
}

export interface WriteOptions {
    /** Overwrite even when the file was edited by hand. */
    force?: boolean;
    /** Render and compare, but do not write. */
    dryRun?: boolean;
}

/**
 * Renders and writes the document, refusing to overwrite a hand edit.
 *
 * 🛑 A `hand-edited` verdict is a refusal, not a warning. Overwriting is the one outcome that
 * cannot be undone from the repository, because the edit exists nowhere else.
 */
export async function writeDocument<T>(
    modulePath: string,
    definition: DocumentDefinition<T>,
    options: WriteOptions = {}
): Promise<WriteResult> {
    const outPath = outputPathFor(modulePath, definition);
    const existing = Bun.file(outPath);

    if (!(await existing.exists())) {
        const built = await buildDocument(modulePath, definition);

        if (!options.dryRun) {
            await Bun.write(built.outPath, built.markdown);
        }

        return { ...built, outcome: options.dryRun ? "unchanged" : "written", check: null };
    }

    const current = await existing.text();
    // Rebuild at the previous timestamp first. Only if THAT still differs has something real
    // changed, so an unchanged document keeps its original generated-at and never re-diffs.
    const pinned = await buildDocument(modulePath, definition, { generatedAt: stripStamp(current).stamp?.generated });
    const check = checkMarkdown({ current, regenerated: pinned.markdown, sourceHash: pinned.sourceHash });

    if (check.verdict === "hand-edited" && !options.force) {
        return { ...pinned, outcome: "refused", check };
    }

    if (check.verdict === "clean") {
        return { ...pinned, outcome: "unchanged", check };
    }

    const fresh = await buildDocument(modulePath, definition);

    if (!options.dryRun) {
        await Bun.write(fresh.outPath, fresh.markdown);
    }

    return { ...fresh, outcome: options.dryRun ? "unchanged" : "written", check };
}

export interface DocumentCheck extends CheckResult {
    outPath: string;
    /** A unified-style preview of what regenerating would change. Empty when clean. */
    diff: string;
}

/** Checks the written document against what the definition produces now. */
export async function checkDocument<T>(modulePath: string, definition: DocumentDefinition<T>): Promise<DocumentCheck> {
    const outPath = outputPathFor(modulePath, definition);
    const file = Bun.file(outPath);

    if (!(await file.exists())) {
        return {
            verdict: "unstamped",
            stamp: null,
            dataChanged: false,
            message: `Not generated yet: ${outPath}`,
            outPath,
            diff: "",
        };
    }

    const current = await file.text();
    // Pinned to the file's own timestamp, so the generated-at line is never itself the change.
    const built = await buildDocument(modulePath, definition, { generatedAt: stripStamp(current).stamp?.generated });
    const check = checkMarkdown({ current, regenerated: built.markdown, sourceHash: built.sourceHash });

    return {
        ...check,
        outPath,
        diff: check.verdict === "clean" ? "" : lineDiff(stripStamp(current).body, built.body),
    };
}

type DiffOp = { kind: " " | "-" | "+"; text: string };

/** Longest common subsequence over lines. Capped, because the table is O(n × m). */
const LCS_LINE_CAP = 2000;

function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
    if (a.length > LCS_LINE_CAP || b.length > LCS_LINE_CAP) {
        // Positional fallback. Less readable, but it never allocates a huge table.
        const ops: DiffOp[] = [];

        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] === b[i]) {
                ops.push({ kind: " ", text: a[i] ?? "" });
                continue;
            }

            if (a[i] !== undefined) {
                ops.push({ kind: "-", text: a[i]! });
            }

            if (b[i] !== undefined) {
                ops.push({ kind: "+", text: b[i]! });
            }
        }

        return ops;
    }

    const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
    }

    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            ops.push({ kind: " ", text: a[i]! });
            i += 1;
            j += 1;
        } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
            ops.push({ kind: "-", text: a[i]! });
            i += 1;
        } else {
            ops.push({ kind: "+", text: b[j]! });
            j += 1;
        }
    }

    while (i < a.length) {
        ops.push({ kind: "-", text: a[i]! });
        i += 1;
    }

    while (j < b.length) {
        ops.push({ kind: "+", text: b[j]! });
        j += 1;
    }

    return ops;
}

/**
 * A unified-style line diff, so the core needs no diff dependency.
 *
 * ⚠️ It aligns on the longest common subsequence rather than comparing line N to line N. A
 * positional comparison marks every line after a single inserted line as changed, which is
 * exactly the shape a hand edit takes, and that noise hides the one line that matters.
 */
export function lineDiff(before: string, after: string, context = 2): string {
    const ops = diffOps(before.split("\n"), after.split("\n"));
    const interesting = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.kind !== " ");

    if (interesting.length === 0) {
        return "";
    }

    const shown = new Set<number>();

    for (const { index } of interesting) {
        for (let i = Math.max(0, index - context); i <= Math.min(ops.length - 1, index + context); i++) {
            shown.add(i);
        }
    }

    const lines: string[] = [];
    let previous = -1;

    for (const index of [...shown].sort((x, y) => x - y)) {
        if (previous !== -1 && index > previous + 1) {
            lines.push("  …");
        }

        const op = ops[index]!;
        lines.push(`${op.kind === " " ? " " : op.kind} ${op.text}`);
        previous = index;
    }

    return lines.join("\n");
}

/**
 * Loads a `.ts` document module and returns its default export.
 *
 * The import is dynamic because the path comes from the user at runtime. That is the one case
 * a static import cannot cover.
 */
export async function loadDocumentModule(modulePath: string): Promise<DefinedDocument> {
    const absolute = isAbsolute(modulePath) ? modulePath : join(process.cwd(), modulePath);
    const loaded: unknown = await import(absolute);
    const candidate = (loaded as { default?: unknown }).default;

    if (isDefinedDocument(candidate)) {
        return candidate;
    }

    if (isDefinedDocument(loaded)) {
        return loaded;
    }

    throw new Error(
        `json2md: ${modulePath} has no default export from defineDocument(). Add:\n  export default defineDocument({ data: "./data.json", render: (d) => [...] });`
    );
}
