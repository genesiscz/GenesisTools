import { createHash } from "node:crypto";
import type { ObservedElement } from "../decision/observation";
import type { IdbElement } from "./idb";

export interface Frame {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Roles iOS treats as controls. `press` is offered only for these, so a model choosing a press
 * is choosing a control rather than any rectangle that happens to be on screen. Everything
 * observed still reaches `click`, which is the same tap through the element's observed frame.
 */
export const PRESSABLE_ROLES = new Set([
    "AXButton",
    "AXCell",
    "AXCheckBox",
    "AXComboBox",
    "AXLink",
    "AXMenuItem",
    "AXPopUpButton",
    "AXRadioButton",
    "AXSearchField",
    "AXSwitch",
    "AXTabButton",
    "AXTextArea",
    "AXTextField",
    "AXToggle",
]);

export const EDITABLE_ROLES = new Set(["AXComboBox", "AXSearchField", "AXTextArea", "AXTextField"]);

/** A stable positive 31-bit integer, for the schema fields that demand one. */
export function stableId(value: string): number {
    const digest = createHash("sha256").update(value).digest();
    return (digest.readUInt32BE(0) % 2_000_000_000) + 1;
}

export function frameCentre(frame: Frame): { x: number; y: number } {
    return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

export function frameArea(frame: Frame): number {
    return Math.max(0, frame.width) * Math.max(0, frame.height);
}

/** True when `outer` fully contains `inner`, with a point of slack for idb's float frames. */
export function contains(outer: Frame, inner: Frame): boolean {
    const slack = 1;
    return (
        outer.x - slack <= inner.x &&
        outer.y - slack <= inner.y &&
        outer.x + outer.width + slack >= inner.x + inner.width &&
        outer.y + outer.height + slack >= inner.y + inner.height
    );
}

export function elementIdentity(element: IdbElement): string {
    const frame = element.frame;
    return [
        element.AXUniqueId ?? "",
        element.AXLabel ?? "",
        element.role ?? element.type ?? "",
        frame.x.toFixed(1),
        frame.y.toFixed(1),
        frame.width.toFixed(1),
        frame.height.toFixed(1),
    ].join("|");
}

/**
 * The same element arrives from `describe-all` and from several grid probes. Keeps the first
 * sighting of each identity and drops zero-area rows, which idb emits when a point hits nothing.
 */
export function dedupeElements(elements: IdbElement[]): IdbElement[] {
    const seen = new Set<string>();
    const kept: IdbElement[] = [];
    for (const element of elements) {
        if (frameArea(element.frame) <= 0) {
            continue;
        }
        const identity = elementIdentity(element);
        if (seen.has(identity)) {
            continue;
        }
        seen.add(identity);
        kept.push(element);
    }
    return kept;
}

function axRole(element: IdbElement): string {
    if (element.role?.startsWith("AX")) {
        return element.role;
    }
    const type = element.type ?? "";
    return type ? `AX${type}` : "AXUnknown";
}

interface TreeNode {
    element: IdbElement;
    children: TreeNode[];
}

/**
 * The probe grid returns a flat list, so the hierarchy is recovered from frame containment:
 * each element becomes a child of the smallest observed element that fully contains it. The
 * result is emitted in pre-order with a depth per row, which is the shape every consumer of
 * `Observation` already assumes.
 */
export function buildContainmentTree(elements: IdbElement[]): TreeNode[] {
    const ordered = [...elements].sort((a, b) => frameArea(b.frame) - frameArea(a.frame));
    const nodes: TreeNode[] = ordered.map((element) => ({ element, children: [] }));
    const roots: TreeNode[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        let parent: TreeNode | undefined;
        for (let candidate = index - 1; candidate >= 0; candidate--) {
            const outer = nodes[candidate];
            if (!contains(outer.element.frame, node.element.frame)) {
                continue;
            }
            if (parent === undefined || frameArea(outer.element.frame) < frameArea(parent.element.frame)) {
                parent = outer;
            }
        }
        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }
    const byReadingOrder = (a: TreeNode, b: TreeNode) =>
        a.element.frame.y - b.element.frame.y || a.element.frame.x - b.element.frame.x;
    const sortDeep = (list: TreeNode[]) => {
        list.sort(byReadingOrder);
        for (const node of list) {
            sortDeep(node.children);
        }
    };
    sortDeep(roots);
    return roots;
}

export interface SimulatorRow extends ObservedElement {
    x: number;
    y: number;
    width: number;
    height: number;
}

function toRow(element: IdbElement, index: number, depth: number, isScreenRoot: boolean): SimulatorRow {
    const role = isScreenRoot ? "AXWindow" : axRole(element);
    const label = element.AXLabel?.trim() ?? "";
    const identifier = element.AXUniqueId ?? undefined;
    const actions: string[] = [];
    if (PRESSABLE_ROLES.has(role) || (element.custom_actions?.length ?? 0) > 0) {
        actions.push("AXPress");
    }
    for (const custom of element.custom_actions ?? []) {
        actions.push(custom);
    }
    const editable = EDITABLE_ROLES.has(role);
    return {
        index,
        depth,
        role,
        ...(identifier ? { AXIdentifier: identifier } : {}),
        ...(label ? { AXDescription: label } : {}),
        ...(element.title ? { AXTitle: element.title } : {}),
        ...(element.AXValue === null || element.AXValue === undefined ? {} : { AXValue: element.AXValue }),
        ...(element.subrole ? { AXSubrole: element.subrole } : {}),
        ...(element.role_description ? { AXRoleDescription: element.role_description } : {}),
        AXEnabled: element.enabled === false ? "0" : "1",
        actions,
        ...(editable ? { valueSettable: true } : {}),
        visible: true,
        x: element.frame.x,
        y: element.frame.y,
        width: element.frame.width,
        height: element.frame.height,
    };
}

/**
 * Clips a frame to the visible screen. A scroll view reports its whole scrollable content, so its
 * raw centre can sit far below the last visible pixel; tapping the clipped centre taps something
 * the caller can actually see. Returns `undefined` when nothing of the element is on screen.
 */
export function clipToScreen(frame: Frame, screen: Frame): Frame | undefined {
    const left = Math.max(frame.x, screen.x);
    const top = Math.max(frame.y, screen.y);
    const right = Math.min(frame.x + frame.width, screen.x + screen.width);
    const bottom = Math.min(frame.y + frame.height, screen.y + screen.height);
    if (right <= left || bottom <= top) {
        return undefined;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Flattens the containment tree into the indexed, depth-tagged rows an `Observation` carries.
 * The application root is reported as `AXWindow` so the shared candidate rules can offer the
 * screen-level actions (a hardware key, a scroll) a target that is not a specific control.
 */
export function toObservedRows(elements: IdbElement[], screen: Frame, appLabel?: string): SimulatorRow[] {
    const visible: IdbElement[] = [];
    for (const element of dedupeElements(elements)) {
        const clipped = clipToScreen(element.frame, screen);
        if (clipped) {
            visible.push({ ...element, frame: clipped });
        }
    }
    const roots = buildContainmentTree(visible);
    const rows: SimulatorRow[] = [];
    const isScreenRoot = (element: IdbElement) => (element.role ?? element.type) === "AXApplication";
    const walk = (node: TreeNode, depth: number) => {
        const root = isScreenRoot(node.element);
        const row = toRow(node.element, rows.length, depth, root);
        if (root && appLabel && !row.AXTitle) {
            row.AXTitle = appLabel;
        }
        rows.push(row);
        for (const child of node.children) {
            walk(child, depth + 1);
        }
    };
    for (const root of roots) {
        walk(root, 0);
    }
    return rows;
}
