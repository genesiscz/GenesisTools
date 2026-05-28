import type { MosaicNode } from "react-mosaic-component";

interface BuildOptions {
    maxColumns: number;
    extraRowPlacement?: "start" | "end";
}

function equalPercentages(count: number): number[] {
    return Array.from({ length: count }, () => Number((100 / count).toFixed(4)));
}

function splitRows<T>(items: T[], { extraRowPlacement = "end", maxColumns }: BuildOptions): T[][] {
    if (!Number.isInteger(maxColumns) || maxColumns < 1) {
        throw new Error(`maxColumns must be an integer >= 1, got ${maxColumns}`);
    }

    if (items.length <= maxColumns) {
        return [items];
    }

    const rowCount = Math.ceil(items.length / maxColumns);
    const baseRowSize = Math.floor(items.length / rowCount);
    const rowsWithExtra = items.length % rowCount;
    const rows: T[][] = [];
    let cursor = 0;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const getsExtra =
            extraRowPlacement === "start" ? rowIndex < rowsWithExtra : rowIndex >= rowCount - rowsWithExtra;
        const rowSize = baseRowSize + (getsExtra ? 1 : 0);
        rows.push(items.slice(cursor, cursor + rowSize));
        cursor += rowSize;
    }

    return rows;
}

function makeRow<T extends string>(items: T[]): MosaicNode<T> {
    if (items.length === 1) {
        return items[0];
    }

    return {
        type: "split",
        direction: "row",
        children: items,
        splitPercentages: equalPercentages(items.length),
    };
}

export function flattenMosaicLeaves<T extends string>(node: MosaicNode<T> | null): T[] {
    if (!node) {
        return [];
    }

    if (typeof node === "string") {
        return [node];
    }

    if (node.type === "tabs") {
        return [...node.tabs];
    }

    return node.children.flatMap((child) => flattenMosaicLeaves(child));
}

export function buildBalancedMosaicLayout<T extends string>(items: T[], options: BuildOptions): MosaicNode<T> | null {
    if (items.length === 0) {
        return null;
    }

    const rows = splitRows(items, options);

    if (rows.length === 1) {
        return makeRow(rows[0]);
    }

    return {
        type: "split",
        direction: "column",
        children: rows.map((row) => makeRow(row)),
        splitPercentages: equalPercentages(rows.length),
    };
}

function rebalancePercentages<T extends string>(node: MosaicNode<T>): MosaicNode<T> {
    if (typeof node === "string" || node.type === "tabs") {
        return node;
    }

    return {
        ...node,
        splitPercentages: equalPercentages(node.children.length),
    };
}

export function pruneMosaicLeaves<T extends string>(
    node: MosaicNode<T> | null,
    leavesToRemove: ReadonlySet<T>
): MosaicNode<T> | null {
    if (!node) {
        return null;
    }

    if (typeof node === "string") {
        return leavesToRemove.has(node) ? null : node;
    }

    if (node.type === "tabs") {
        const tabs = node.tabs.filter((tab) => !leavesToRemove.has(tab));

        if (tabs.length === 0) {
            return null;
        }

        if (tabs.length === 1) {
            return tabs[0];
        }

        return {
            ...node,
            tabs,
            activeTabIndex: Math.min(node.activeTabIndex, tabs.length - 1),
        };
    }

    const children = node.children
        .map((child) => pruneMosaicLeaves(child, leavesToRemove))
        .filter((child) => child !== null);

    if (children.length === 0) {
        return null;
    }

    if (children.length === 1) {
        return children[0];
    }

    return rebalancePercentages({
        ...node,
        children,
    });
}

export function reconcileMosaicLayout<T extends string>(
    current: MosaicNode<T> | null,
    nextItems: T[],
    options: BuildOptions
): MosaicNode<T> | null {
    if (nextItems.length === 0) {
        return null;
    }

    if (!current) {
        return buildBalancedMosaicLayout(nextItems, options);
    }

    const nextItemSet = new Set(nextItems);
    const currentLeaves = flattenMosaicLeaves(current);
    const retainedItems = currentLeaves.filter((item) => nextItemSet.has(item));
    const retainedItemSet = new Set(retainedItems);
    const addedItems = nextItems.filter((item) => !retainedItemSet.has(item));
    const removedItems = currentLeaves.filter((item) => !nextItemSet.has(item));

    if (addedItems.length === 0 && removedItems.length === 0) {
        return current;
    }

    if (addedItems.length === 0 && removedItems.length > 0) {
        const pruned = pruneMosaicLeaves(current, new Set(removedItems));

        if (pruned) {
            return pruned;
        }

        return buildBalancedMosaicLayout(nextItems, options);
    }

    return buildBalancedMosaicLayout([...retainedItems, ...addedItems], options);
}
