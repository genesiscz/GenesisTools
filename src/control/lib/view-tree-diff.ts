import type { Annotation, AnnotationRect } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { CHANGE_COLOR, DATA_COLOR, regionAnnotations } from "./diff-regions";

/**
 * The view tree GenesisTools.app writes beside a `--snapshot` PNG (`shot.png` -> `shot.tree.json`,
 * Sources/Host/App/SnapshotViewTree.swift): each accessibility element's role path, identifier, label presence (never
 * the text), frame in window points and style flags. Diffing two trees tells a layout or style change from a screen that
 * only shows other data, which a pixel diff cannot: on 2026-10-11 33 before/after pairs from different sessions marked
 * nearly every pixel as changed.
 */
export interface TreeNode {
    path: string;
    role: string;
    subrole?: string;
    identifier?: string;
    hasLabel: boolean;
    frame?: AnnotationRect;
    enabled?: boolean;
    selected?: boolean;
    depth: number;
}

export interface ViewTree {
    version: number;
    face: string;
    source: string;
    window: { width: number; height: number };
    truncated: boolean;
    nodes: TreeNode[];
}

export type TreeChangeKind = "moved" | "resized" | "added" | "removed" | "restyled";

export interface TreeChange {
    kind: TreeChangeKind;
    key: string;
    role: string;
    identifier?: string;
    before?: AnnotationRect;
    after?: AnnotationRect;
    /** For `restyled`: the flags that differ (`enabled`, `selected`, `hasLabel`). */
    fields?: string[];
}

/** A difference the data explains: a list with more or fewer rows, text of another width and what it pushed along. */
export interface DataDifference {
    key: string;
    reason: "row count" | "row content" | "row position" | "row state" | "text width" | "follows text" | "image";
    before?: AnnotationRect;
    after?: AnnotationRect;
    detail?: string;
}

export interface TreeDiff {
    changes: TreeChange[];
    dataOnly: DataDifference[];
    matched: number;
}

export function treeSidecarPath(pathOrPng: string): string {
    return pathOrPng.endsWith(".tree.json") ? pathOrPng : `${pathOrPng.replace(/\.png$/i, "")}.tree.json`;
}

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function rectOf(value: unknown): AnnotationRect | undefined {
    const fields = fieldsOf(value);
    if (
        !fields ||
        typeof fields.x !== "number" ||
        typeof fields.y !== "number" ||
        typeof fields.w !== "number" ||
        typeof fields.h !== "number"
    ) {
        return undefined;
    }

    return { x: fields.x, y: fields.y, w: fields.w, h: fields.h };
}

function nodeOf(value: unknown): TreeNode | undefined {
    const fields = fieldsOf(value);
    if (!fields || typeof fields.path !== "string" || typeof fields.role !== "string") {
        return undefined;
    }

    const frame = rectOf(fields.frame);
    return {
        path: fields.path,
        role: fields.role,
        depth: typeof fields.depth === "number" ? fields.depth : fields.path.split("/").length - 1,
        hasLabel: fields.hasLabel === true,
        ...(typeof fields.subrole === "string" ? { subrole: fields.subrole } : {}),
        ...(typeof fields.identifier === "string" ? { identifier: fields.identifier } : {}),
        ...(frame ? { frame } : {}),
        ...(typeof fields.enabled === "boolean" ? { enabled: fields.enabled } : {}),
        ...(typeof fields.selected === "boolean" ? { selected: fields.selected } : {}),
    };
}

export function parseViewTree(value: unknown): ViewTree | undefined {
    const fields = fieldsOf(value);
    const window = fieldsOf(fields?.window);
    if (
        !fields ||
        !Array.isArray(fields.nodes) ||
        typeof window?.width !== "number" ||
        typeof window.height !== "number"
    ) {
        return undefined;
    }

    const nodes = fields.nodes.map(nodeOf).filter((node): node is TreeNode => node !== undefined);
    return {
        version: typeof fields.version === "number" ? fields.version : 1,
        face: typeof fields.face === "string" ? fields.face : "unknown",
        source: typeof fields.source === "string" ? fields.source : "unknown",
        window: { width: window.width, height: window.height },
        truncated: fields.truncated === true,
        nodes,
    };
}

/** The tree for a PNG or a `.tree.json` path; undefined when the file is missing or of another shape. */
export async function readViewTree(pathOrPng: string): Promise<ViewTree | undefined> {
    const path = treeSidecarPath(pathOrPng);
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return undefined;
    }

    const tree = parseViewTree(SafeJSON.parse(await file.text(), { strict: true }));
    if (!tree) {
        logger.warn({ path }, "view tree has an unknown shape");
    }

    return tree;
}

/** Containers whose children are data rows: their count is data, only the first row's layout is compared. */
const ROW_CONTAINERS = new Set(["AXTable", "AXOutline", "AXList", "AXGrid"]);
const REPEAT_MIN = 3;
/** Subtrees whose frames follow the content's length or the scroll offset, never the layout. */
const CONTENT_SIZED = new Set(["AXScrollBar", "AXColumn"]);

interface Keyed {
    node: TreeNode;
    key: string;
    /** Inside a repeated row after the first one: data, never compared. */
    extraRow: boolean;
    /** Inside the first row of a repeated group (`role[*]`): its position and state follow the data. */
    inTemplate: boolean;
    contentSized: boolean;
    leaf: boolean;
    parentKey: string | undefined;
}

function segmentRole(segment: string): string {
    return segment.replace(/\[\d+\]$/, "");
}

function parentOf(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function visible(node: TreeNode, window: { width: number; height: number }): boolean {
    if (!node.frame) {
        return true;
    }

    const { x, y, w, h } = node.frame;
    return x < window.width && y < window.height && x + w > 0 && y + h > 0;
}

/**
 * Gives every node a key: its identifier when one is set and unique (not an image's, which names its symbol and follows
 * the data), else its role path. A repeated group (three or more same-role siblings under a table, outline or list,
 * inside a scroll area, or with children of their own) keeps only its first member as `role[*]`; the others are data
 * rows. Elements outside the window (scrolled away) are not in the picture and are left out.
 */
function keyNodes(tree: ViewTree): { keyed: Keyed[]; rowCounts: Map<string, number> } {
    const children = new Map<string, TreeNode[]>();
    const byPath = new Map<string, TreeNode>();
    for (const node of tree.nodes) {
        byPath.set(node.path, node);
        const parent = parentOf(node.path);
        const list = children.get(parent) ?? [];
        list.push(node);
        children.set(parent, list);
    }

    const inScroll = (path: string): boolean => {
        for (let current = path; current; current = parentOf(current)) {
            if (byPath.get(current)?.role === "AXScrollArea") {
                return true;
            }
        }

        return false;
    };

    const repeated = new Set<string>();
    const rowCounts = new Map<string, number>();
    for (const [parent, list] of children) {
        const parentRole = parent ? (byPath.get(parent)?.role ?? "") : "";
        const byRole = new Map<string, TreeNode[]>();
        for (const child of list) {
            const group = byRole.get(child.role) ?? [];
            group.push(child);
            byRole.set(child.role, group);
        }

        for (const [role, group] of byRole) {
            const hasChildren = group.every((member) => (children.get(member.path)?.length ?? 0) > 0);
            if (group.length >= REPEAT_MIN && (ROW_CONTAINERS.has(parentRole) || hasChildren || inScroll(parent))) {
                repeated.add(`${parent}/${role}`);
                rowCounts.set(`${parent}/${role}`, group.length);
            }
        }
    }

    const identifierCounts = new Map<string, number>();
    for (const node of tree.nodes) {
        if (node.identifier) {
            identifierCounts.set(node.identifier, (identifierCounts.get(node.identifier) ?? 0) + 1);
        }
    }

    const keyed: Keyed[] = [];
    const keyOfPath = new Map<string, string>();
    for (const node of tree.nodes) {
        const segments = node.path.split("/");
        let extraRow = false;
        let inTemplate = false;
        let contentSized = false;
        const normal = segments.map((segment, index) => {
            const parent = segments.slice(0, index).join("/");
            const role = segmentRole(segment);
            if (CONTENT_SIZED.has(role)) {
                contentSized = true;
            }

            if (index > 0 && repeated.has(`${parent}/${role}`)) {
                inTemplate = true;
                if (!segment.endsWith("[0]")) {
                    extraRow = true;
                }

                return `${role}[*]`;
            }

            return segment;
        });
        const unique = node.identifier && node.role !== "AXImage" && identifierCounts.get(node.identifier) === 1;
        const key = unique ? `#${node.identifier}` : normal.join("/");
        keyOfPath.set(node.path, key);
        if (!visible(node, tree.window)) {
            continue;
        }

        const parentPath = parentOf(node.path);
        keyed.push({
            node,
            key,
            extraRow,
            inTemplate,
            contentSized,
            leaf: (children.get(node.path)?.length ?? 0) === 0,
            parentKey: parentPath ? keyOfPath.get(parentPath) : undefined,
        });
    }

    return { keyed, rowCounts };
}

function sameRect(a: AnnotationRect | undefined, b: AnnotationRect | undefined, tolerance: number): boolean {
    if (!a || !b) {
        return a === b;
    }

    return (
        Math.abs(a.x - b.x) <= tolerance &&
        Math.abs(a.y - b.y) <= tolerance &&
        Math.abs(a.w - b.w) <= tolerance &&
        Math.abs(a.h - b.h) <= tolerance
    );
}

/** A leaf whose width changed and nothing else but its x or right edge: text of another length. */
function textWidthOnly(was: Keyed, now: Keyed, tolerance: number): boolean {
    const a = was.node.frame;
    const b = now.node.frame;
    if (
        !a ||
        !b ||
        !was.leaf ||
        was.node.role !== "AXStaticText" ||
        now.node.role !== "AXStaticText" ||
        Math.abs(a.h - b.h) > tolerance ||
        Math.abs(a.y - b.y) > tolerance
    ) {
        return false;
    }

    return Math.abs(a.w - b.w) > tolerance;
}

/**
 * Matches two trees by key and reports what moved, resized, appeared, disappeared or changed its flags. Text values are
 * never compared. Data-only, never a change: another row count, a leaf of another width (text) and the siblings it
 * pushed along, the first row of a list moving or changing state, an image that shows another symbol, and the frames
 * of scroll bars and table columns (they follow the content's length). A node that moved with its parent by the same
 * offset is not reported again, nor is the child of an added or removed node.
 */
export function diffViewTrees(
    before: ViewTree,
    after: ViewTree,
    { tolerance = 1 }: { tolerance?: number } = {}
): TreeDiff {
    const a = keyNodes(before);
    const b = keyNodes(after);
    const dataOnly: DataDifference[] = [];
    for (const [group, count] of a.rowCounts) {
        const next = b.rowCounts.get(group);
        if (next !== undefined && next !== count) {
            dataOnly.push({ key: group, reason: "row count", detail: `${count} -> ${next}` });
        }
    }

    const index = (keyed: Keyed[]) => {
        const map = new Map<string, Keyed>();
        for (const entry of keyed) {
            if (!entry.extraRow && !entry.contentSized && !map.has(entry.key)) {
                map.set(entry.key, entry);
            }
        }

        return map;
    };
    const left = index(a.keyed);
    const right = index(b.keyed);

    const textResizedParents = new Set<string>();
    const offsets = new Map<string, { dx: number; dy: number }>();
    for (const [key, was] of left) {
        const now = right.get(key);
        if (!now || !was.node.frame || !now.node.frame) {
            continue;
        }

        offsets.set(key, { dx: now.node.frame.x - was.node.frame.x, dy: now.node.frame.y - was.node.frame.y });
        if (textWidthOnly(was, now, tolerance) && was.parentKey) {
            textResizedParents.add(was.parentKey);
        }
    }

    const changes: TreeChange[] = [];
    let matched = 0;
    for (const [key, was] of left) {
        const now = right.get(key);
        if (!now) {
            if (was.inTemplate) {
                dataOnly.push({ key, reason: "row content", before: was.node.frame });
            } else if (!(was.parentKey && !right.has(was.parentKey) && left.has(was.parentKey))) {
                changes.push({
                    kind: "removed",
                    key,
                    role: was.node.role,
                    identifier: was.node.identifier,
                    before: was.node.frame,
                });
            }

            continue;
        }

        matched++;
        if (was.node.role === "AXImage" && was.node.identifier !== now.node.identifier) {
            dataOnly.push({ key, reason: "image", before: was.node.frame, after: now.node.frame });
        }

        const fields = (["enabled", "selected", "hasLabel"] as const).filter(
            (field) => was.node[field] !== now.node[field]
        );
        if (fields.length > 0 && was.inTemplate) {
            dataOnly.push({ key, reason: "row state", after: now.node.frame, detail: fields.join(", ") });
        } else if (fields.length > 0) {
            changes.push({
                kind: "restyled",
                key,
                role: was.node.role,
                identifier: was.node.identifier,
                before: was.node.frame,
                after: now.node.frame,
                fields: [...fields],
            });
        }

        if (sameRect(was.node.frame, now.node.frame, tolerance) || !was.node.frame || !now.node.frame) {
            continue;
        }

        const resized =
            Math.abs(was.node.frame.w - now.node.frame.w) > tolerance ||
            Math.abs(was.node.frame.h - now.node.frame.h) > tolerance;
        const offset = offsets.get(key);
        const parentOffset = was.parentKey ? offsets.get(was.parentKey) : undefined;
        const movedWithParent =
            !resized &&
            offset !== undefined &&
            parentOffset !== undefined &&
            Math.abs(offset.dx - parentOffset.dx) <= tolerance &&
            Math.abs(offset.dy - parentOffset.dy) <= tolerance;
        if (movedWithParent) {
            continue;
        }

        const reason = was.inTemplate
            ? "row position"
            : textWidthOnly(was, now, tolerance)
              ? "text width"
              : !resized && was.parentKey && textResizedParents.has(was.parentKey)
                ? "follows text"
                : undefined;
        if (reason) {
            dataOnly.push({ key, reason, before: was.node.frame, after: now.node.frame });
            continue;
        }

        changes.push({
            kind: resized ? "resized" : "moved",
            key,
            role: was.node.role,
            identifier: was.node.identifier,
            before: was.node.frame,
            after: now.node.frame,
        });
    }

    for (const [key, now] of right) {
        if (left.has(key)) {
            continue;
        }

        if (now.inTemplate) {
            dataOnly.push({ key, reason: "row content", after: now.node.frame });
        } else if (!(now.parentKey && !left.has(now.parentKey) && right.has(now.parentKey))) {
            changes.push({
                kind: "added",
                key,
                role: now.node.role,
                identifier: now.node.identifier,
                after: now.node.frame,
            });
        }
    }

    return { changes, dataOnly, matched };
}

/** A frame in window points as image pixels. */
export function scaleRect(rect: AnnotationRect, scale: number): AnnotationRect {
    return {
        x: Math.round(rect.x * scale),
        y: Math.round(rect.y * scale),
        w: Math.round(rect.w * scale),
        h: Math.round(rect.h * scale),
    };
}

/**
 * The tree diff as `draw` plans for each side, in image pixels (`scale` is image pixels per point): a red box per
 * change on the side that shows it, and with `dataOnly` an amber box per data-only difference on the after side.
 */
export function treeDiffAnnotations(
    diff: TreeDiff,
    { scale, dataOnly = true }: { scale: { before: number; after: number }; dataOnly?: boolean }
): { before: Annotation[]; after: Annotation[] } {
    const label = (kind: string, key: string) => `${kind} ${key.split("/").at(-1)}`;
    const side = (which: "before" | "after") =>
        diff.changes.flatMap((change) => {
            const rect = which === "before" ? change.before : change.after;
            const shown = which === "before" ? change.kind !== "added" : change.kind !== "removed";
            return rect && shown ? [{ ...scaleRect(rect, scale[which]), label: label(change.kind, change.key) }] : [];
        });
    const data = dataOnly
        ? diff.dataOnly.flatMap((entry) =>
              entry.after ? [{ ...scaleRect(entry.after, scale.after), label: entry.reason }] : []
          )
        : [];
    return {
        before: regionAnnotations(side("before"), { stroke: CHANGE_COLOR }),
        after: [
            ...regionAnnotations(side("after"), { stroke: CHANGE_COLOR }),
            ...regionAnnotations(data, { stroke: DATA_COLOR, strokeWidth: 2 }),
        ],
    };
}
