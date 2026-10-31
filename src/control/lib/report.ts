import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    type Annotation,
    type AnnotationRect,
    decodeImageRgba,
    decodeImageRgbaScaled,
    encodeRgbaToPng,
    renderAnnotationPlan,
} from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import {
    CHANGE_COLOR,
    DATA_COLOR,
    DEFAULT_REGION_OPTIONS,
    type DiffRegion,
    findDiffRegions,
    regionAnnotations,
} from "./diff-regions";
import { comparePairGeometry, describeGeometry, readSnapshotGeometry } from "./snapshot-geometry";
import { diffViewTrees, readViewTree, scaleRect, type TreeDiff, treeDiffAnnotations } from "./view-tree-diff";

/** One screen of a before/after report. Paths are absolute once loaded. */
export interface ReportPair {
    screen: string;
    before: string;
    after: string;
    /** The fix id this screen shows (`H12`), and one sentence about what changed. */
    fix?: string;
    note?: string;
}

export interface ReportInput {
    title: string;
    pairs: ReportPair[];
}

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function optionalText(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Change notes per screen: `{"<screen>": {"fix": "H12", "note": "…"}}`. */
export type ReportNotes = Record<string, { fix?: string; note?: string }>;

export function parseReportNotes(value: unknown): ReportNotes {
    const notes: ReportNotes = {};
    for (const [screen, entry] of Object.entries(fieldsOf(value) ?? {})) {
        const fields = fieldsOf(entry);
        notes[screen] = { fix: optionalText(fields?.fix), note: optionalText(fields?.note) };
    }

    return notes;
}

/** A shot list: `{title?, pairs: [{screen, before, after, fix?, note?}]}`, paths relative to the file's folder. */
export function parseShotList(value: unknown, folder: string): ReportInput {
    const fields = fieldsOf(value);
    if (!fields || !Array.isArray(fields.pairs)) {
        throw new Error('a shot list is {"title"?, "pairs": [{"screen", "before", "after", "fix"?, "note"?}]}');
    }

    const pairs = fields.pairs.map((entry, index) => {
        const pair = fieldsOf(entry);
        const before = optionalText(pair?.before);
        const after = optionalText(pair?.after);
        if (!before || !after) {
            throw new Error(`pair ${index + 1} needs "before" and "after" image paths`);
        }

        return {
            screen: optionalText(pair?.screen) ?? `screen-${index + 1}`,
            before: isAbsolute(before) ? before : resolve(folder, before),
            after: isAbsolute(after) ? after : resolve(folder, after),
            fix: optionalText(pair?.fix),
            note: optionalText(pair?.note),
        };
    });
    return { title: optionalText(fields.title) ?? "Before and after", pairs };
}

const PAIR_PATTERN = /^(.*?)[-_.]?(before|after)\.(png|webp|jpe?g)$/i;

/** Existing pairs in a folder: `<stem>-before.<ext>` with its `<stem>-after.<ext>`, in name order. */
export async function pairsInFolder(folder: string): Promise<ReportPair[]> {
    const names = (await readdir(folder)).sort();
    const stems = new Map<string, { before?: string; after?: string }>();
    for (const name of names) {
        const match = PAIR_PATTERN.exec(name);
        if (!match) {
            continue;
        }

        const entry = stems.get(match[1]) ?? {};
        entry[match[2].toLowerCase() === "before" ? "before" : "after"] = join(folder, name);
        stems.set(match[1], entry);
    }

    const pairs: ReportPair[] = [];
    for (const [stem, entry] of stems) {
        if (entry.before && entry.after) {
            pairs.push({ screen: stem.replace(/^\d+[-_]/, ""), before: entry.before, after: entry.after });
        } else {
            logger.warn({ stem, folder }, "report: a shot without its partner is skipped");
        }
    }

    return pairs;
}

function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "screen"
    );
}

function overlaps(a: AnnotationRect, b: AnnotationRect, margin: number): boolean {
    return a.x - margin < b.x + b.w && b.x - margin < a.x + a.w && a.y - margin < b.y + b.h && b.y - margin < a.y + a.h;
}

export interface ClassifiedRegion extends DiffRegion {
    /** `change`: a tree change covers it, or no tree exists to say otherwise; `data`: only the data differs. */
    kind: "change" | "data";
}

/**
 * Colours the pixel regions: with a tree diff, a region that overlaps a tree change (either side) is a change and every
 * other region is data; without one, every region is a change, because pixels alone cannot tell data from design.
 */
export function classifyRegions({
    regions,
    tree,
    scale,
}: {
    regions: DiffRegion[];
    tree: TreeDiff | undefined;
    scale: number;
}): ClassifiedRegion[] {
    if (!tree) {
        return regions.map((region) => ({ ...region, kind: "change" }));
    }

    const changeRects = tree.changes.flatMap((change) =>
        [change.before, change.after]
            .filter((rect): rect is AnnotationRect => rect !== undefined)
            .map((rect) => scaleRect(rect, scale))
    );
    return regions.map((region) => ({
        ...region,
        kind: changeRects.some((rect) => overlaps(rect, region, 4 * scale)) ? "change" : "data",
    }));
}

export interface PairResult extends ReportPair {
    index: number;
    status: "ok" | "refused";
    message?: string;
    geometry?: string;
    regions: ClassifiedRegion[];
    tree?: TreeDiff;
    beforeOut?: string;
    afterOut?: string;
}

export interface ReportOptions {
    outDir: string;
    threshold: number;
    mergeDistance?: number;
    minArea?: number;
    resizeToMatch?: boolean;
}

function regionPlan(regions: ClassifiedRegion[]): Annotation[] {
    const changes = regions.filter((region) => region.kind === "change");
    const data = regions.filter((region) => region.kind === "data");
    return [
        ...regionAnnotations(changes, { stroke: CHANGE_COLOR }),
        ...regionAnnotations(
            data.map((region) => ({ ...region, label: "data" })),
            { stroke: DATA_COLOR, strokeWidth: 2 }
        ),
    ];
}

/** Checks, diffs and annotates one pair, writing `NN-<screen>-1-before.png` and `NN-<screen>-2-after.png`. */
export async function reportPair(pair: ReportPair, index: number, options: ReportOptions): Promise<PairResult> {
    const prefix = `${String(index).padStart(2, "0")}-${slug(pair.screen)}`;
    const base: PairResult = { ...pair, index, status: "ok", regions: [] };
    const geometry = comparePairGeometry(
        await readSnapshotGeometry(pair.before),
        await readSnapshotGeometry(pair.after)
    );
    if (geometry.kind === "size-mismatch" && !options.resizeToMatch) {
        return { ...base, status: "refused", message: geometry.message };
    }

    const a = await decodeImageRgba(pair.before);
    let b = await decodeImageRgba(pair.after);
    let afterInput: string | Buffer = pair.after;
    let note = geometry.kind === "rescale" || geometry.kind === "size-mismatch" ? geometry.message : undefined;
    if (a.width !== b.width || a.height !== b.height) {
        if (!options.resizeToMatch && geometry.kind !== "rescale") {
            return {
                ...base,
                status: "refused",
                message: `image size differs: ${a.width}x${a.height} vs ${b.width}x${b.height} px`,
            };
        }

        b = await decodeImageRgbaScaled(pair.after, a.width, a.height);
        afterInput = encodeRgbaToPng(b.data, b.width, b.height);
        note = note ?? `B resampled from its pixels to A's ${a.width}x${a.height}`;
    }

    const { regions } = findDiffRegions(a, b, {
        threshold: options.threshold,
        mergeDistance: options.mergeDistance ?? DEFAULT_REGION_OPTIONS.mergeDistance,
        minArea: options.minArea ?? DEFAULT_REGION_OPTIONS.minArea,
    });
    const [treeBefore, treeAfter] = await Promise.all([readViewTree(pair.before), readViewTree(pair.after)]);
    const usable = treeBefore && treeAfter && treeBefore.source !== "none" && treeAfter.source !== "none";
    // A cut tree is silent about the controls it left out, and the trees of two point sizes do not share coordinates
    // once B is resampled: either way no region may be called data, so every region stays a change.
    const truncated = usable && (treeBefore.truncated || treeAfter.truncated);
    const resampledPoints = geometry.kind === "size-mismatch";
    const tree = usable && !truncated && !resampledPoints ? diffViewTrees(treeBefore, treeAfter) : undefined;
    if (truncated) {
        note = [note, "a view tree was cut at its node or depth limit, so no region is called data"]
            .filter(Boolean)
            .join("; ");
    } else if (usable && resampledPoints) {
        note = [note, "the point sizes differ, so the view trees do not classify the regions"]
            .filter(Boolean)
            .join("; ");
    }
    const scale = geometry.kind === "unknown" ? 1 : geometry.a.scale;
    const classified = classifyRegions({ regions, tree, scale });

    await mkdir(options.outDir, { recursive: true });
    const beforeOut = join(options.outDir, `${prefix}-1-before.png`);
    const afterOut = join(options.outDir, `${prefix}-2-after.png`);
    const plan = regionPlan(classified);
    const treePlan = tree
        ? treeDiffAnnotations(tree, { scale: { before: scale, after: scale }, dataOnly: false })
        : undefined;
    const [drawnBefore, drawnAfter] = await Promise.all([
        renderAnnotationPlan({ input: pair.before, annotations: [...plan, ...(treePlan?.before ?? [])] }),
        renderAnnotationPlan({ input: afterInput, annotations: [...plan, ...(treePlan?.after ?? [])] }),
    ]);
    await Promise.all([Bun.write(beforeOut, drawnBefore.png), Bun.write(afterOut, drawnAfter.png)]);
    logger.debug(
        { screen: pair.screen, regions: classified.length, treeChanges: tree?.changes.length, beforeOut, afterOut },
        "report pair"
    );

    return {
        ...base,
        message: note,
        geometry: geometry.kind === "unknown" ? undefined : describeGeometry(geometry.a),
        regions: classified,
        tree,
        beforeOut,
        afterOut,
    };
}

function link(target: string, noteDir: string): string {
    return relative(noteDir, target)
        .split("\\")
        .join("/")
        .split("/")
        .map((segment) =>
            encodeURIComponent(segment).replace(
                /[!'()*]/g,
                (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
            )
        )
        .join("/");
}

/** The markdown note: a legend, then per pair its fix, sentence, findings and the annotated before and after. */
export function renderReportMarkdown({
    title,
    results,
    notePath,
    openCommand,
    writtenAt,
}: {
    title: string;
    results: PairResult[];
    notePath: string;
    openCommand: string;
    writtenAt: string;
}): string {
    const noteDir = dirname(notePath);
    const lines = [
        `# ${title}`,
        "",
        `Written ${writtenAt} by \`${toolCommand("control report")}\`. ${results.length} pair(s).`,
        "",
        "How to read the boxes:",
        "- **Red**: a real change. The view-tree diff found a control that moved, resized, appeared, disappeared or changed state, or a pixel region overlaps one. Without a view tree on both sides every pixel region is red, because pixels alone cannot tell data from design.",
        "- **Amber**: only the data differs (other sessions, counts, times or text). It is not a change.",
        "",
        `To see the pairs side by side in Preview: \`${openCommand}\``,
        "",
    ];
    for (const result of results) {
        const heading = `## ${String(result.index).padStart(2, "0")} ${result.screen}${result.fix ? ` (${result.fix})` : ""}`;
        lines.push(heading, "");
        if (result.note) {
            lines.push(result.note, "");
        }

        if (result.status === "refused") {
            lines.push(`Refused: ${result.message}. Render both sides at the same \`--width\` and \`--height\`.`, "");
            continue;
        }

        const changes = result.regions.filter((region) => region.kind === "change").length;
        const data = result.regions.length - changes;
        const facts = [
            result.geometry ? `captured at ${result.geometry}` : "no geometry sidecar",
            result.tree
                ? `view tree: ${result.tree.changes.length} change(s), ${result.tree.dataOnly.length} data-only difference(s)`
                : "no view tree on both sides (take hub shots with --snapshot-tree)",
            `pixel regions: ${changes} red, ${data} amber`,
        ];
        lines.push(`${facts.join("; ")}.`);
        if (result.message) {
            lines.push("", result.message);
        }

        for (const change of result.tree?.changes ?? []) {
            const fields = change.fields ? ` (${change.fields.join(", ")})` : "";
            lines.push(`- ${change.kind} \`${change.key}\`${fields}`);
        }

        if (result.beforeOut && result.afterOut) {
            lines.push(
                "",
                "| Before | After |",
                "| --- | --- |",
                `| ![before](${link(result.beforeOut, noteDir)}) | ![after](${link(result.afterOut, noteDir)}) |`
            );
        }

        lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
}

/** Copies are not needed for annotated output; the order file lists every written image, before then after. */
export function orderLines(results: PairResult[]): string[] {
    return results.flatMap((result) =>
        result.beforeOut && result.afterOut ? [result.beforeOut, result.afterOut] : []
    );
}

/** One line that opens the pairs in Preview in order; a fresh folder keeps Preview from skipping open files. */
export function previewOpenCommand(orderFile: string): string {
    return `tr '\\n' '\\0' < ${shellQuote(orderFile)} | xargs -0 open -a Preview`;
}

/** Loads the report input: a shot list JSON file, or a folder of existing `-before`/`-after` pairs. */
export async function loadReportInput(path: string, notes: ReportNotes = {}): Promise<ReportInput> {
    const stats = await Bun.file(path).stat();
    const input = stats.isDirectory()
        ? { title: `Before and after: ${basename(path)}`, pairs: await pairsInFolder(path) }
        : parseShotList(SafeJSON.parse(await Bun.file(path).text(), { strict: true }), dirname(path));
    return {
        ...input,
        pairs: input.pairs.map((pair) => ({ ...pair, ...(notes[pair.screen] ?? {}) })),
    };
}

/** Copies a source image beside the report when asked for raw pairs (`--raw`), named for Preview's sort. */
export async function copyRaw(result: PairResult, outDir: string): Promise<string[]> {
    const prefix = `${String(result.index).padStart(2, "0")}-${slug(result.screen)}`;
    const targets = [
        join(outDir, "raw", `${prefix}-1-before${extname(result.before)}`),
        join(outDir, "raw", `${prefix}-2-after${extname(result.after)}`),
    ];
    await mkdir(join(outDir, "raw"), { recursive: true });
    await copyFile(result.before, targets[0]);
    await copyFile(result.after, targets[1]);
    return targets;
}
