/**
 * Saved-query trees. A flat WIQL result lists `workItems`. A tree or one-hop
 * result leaves that empty and returns `workItemRelations` instead, which is
 * why reading only `workItems` shows an empty release query.
 */

export interface QueryColumn {
    name: string;
    referenceName: string;
}

export interface QueryTreeColumn extends QueryColumn {
    /** Key into `QueryTreeNode.values`. The column name, unless that name is reused. */
    key: string;
}

export interface QueryRelation {
    sourceId: number | null;
    targetId: number;
}

export interface QueryResultShape {
    workItems?: Array<{ id: number } | null> | null;
    workItemRelations?: Array<{
        source?: { id: number } | null;
        target?: { id: number } | null;
    }> | null;
}

export interface SavedQueryDefinition {
    id: string;
    name: string;
    path: string;
    queryType: string;
    wiql: string | null;
    columns: QueryColumn[];
}

export interface QueryTreeNode {
    id: number;
    url: string;
    values: Record<string, string | null>;
    children: QueryTreeNode[];
}

export interface QueryTreeView {
    id: string;
    name: string;
    path: string;
    queryType: string;
    wiql: string | null;
    asOf: string | null;
    columns: QueryTreeColumn[];
    roots: QueryTreeNode[];
}

export const FALLBACK_QUERY_COLUMNS: QueryColumn[] = [
    { name: "ID", referenceName: "System.Id" },
    { name: "Work Item Type", referenceName: "System.WorkItemType" },
    { name: "Title", referenceName: "System.Title" },
    { name: "Assigned To", referenceName: "System.AssignedTo" },
    { name: "State", referenceName: "System.State" },
];

// Only the fields the heading prints. System.Parent stays a column: indentation does not show its
// value, and a flat query has every item as a root.
const STRUCTURAL_FIELDS = new Set(["System.Id", "System.WorkItemType", "System.Title"]);

export function workItemIdsFromQueryResult(result: QueryResultShape): number[] {
    const ids: number[] = [];
    const seen = new Set<number>();

    const push = (id: number | undefined): void => {
        if (id == null || seen.has(id)) {
            return;
        }

        seen.add(id);
        ids.push(id);
    };

    for (const item of result.workItems ?? []) {
        push(item?.id);
    }

    for (const relation of result.workItemRelations ?? []) {
        push(relation.source?.id);
        push(relation.target?.id);
    }

    return ids;
}

export function relationsFromQueryResult(result: QueryResultShape): QueryRelation[] {
    const relations = result.workItemRelations ?? [];

    if (relations.length > 0) {
        const links: QueryRelation[] = [];

        for (const relation of relations) {
            const targetId = relation.target?.id;

            if (targetId == null) {
                continue;
            }

            links.push({ sourceId: relation.source?.id ?? null, targetId });
        }

        return links;
    }

    return (result.workItems ?? []).flatMap((item) => {
        if (item?.id == null) {
            return [];
        }

        return [{ sourceId: null, targetId: item.id }];
    });
}

export function displayFieldValue(value: unknown): string | null {
    if (value == null) {
        return null;
    }

    if (typeof value === "string") {
        const text = (looksLikeHtml(value) ? stripHtml(value) : value).replace(/\s+/g, " ").trim();

        return text.length === 0 ? null : text;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    if (Array.isArray(value)) {
        const parts = value.map((part) => displayFieldValue(part)).filter((part): part is string => part != null);

        return parts.length === 0 ? null : parts.join(", ");
    }

    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const displayName = record.displayName;
        const uniqueName = record.uniqueName;

        if (typeof displayName === "string" && displayName.trim().length > 0) {
            return displayName.trim();
        }

        if (typeof uniqueName === "string" && uniqueName.trim().length > 0) {
            return uniqueName.trim();
        }
    }

    return null;
}

export function buildQueryTreeView(input: {
    id: string;
    name: string;
    path: string;
    queryType: string;
    wiql: string | null;
    asOf: string | null;
    columns: QueryColumn[];
    relations: QueryRelation[];
    fieldsById: ReadonlyMap<number, Record<string, unknown>>;
    urlFor?: (id: number) => string;
}): QueryTreeView {
    const columns = columnKeys(input.columns);
    const { rootIds, childrenOf } = buildForest(input.relations);

    const toNode = (id: number, stack: Set<number>): QueryTreeNode => {
        const fields = input.fieldsById.get(id) ?? {};
        const node: QueryTreeNode = {
            id,
            url: input.urlFor?.(id) ?? "",
            values: valuesFor(id, columns, fields),
            children: [],
        };

        // A hierarchy link that points at an ancestor would recurse forever.
        if (stack.has(id)) {
            return node;
        }

        stack.add(id);
        node.children = (childrenOf.get(id) ?? []).map((childId) => toNode(childId, stack));
        stack.delete(id);

        return node;
    };

    return {
        id: input.id,
        name: input.name,
        path: input.path,
        queryType: input.queryType,
        wiql: input.wiql,
        asOf: input.asOf,
        columns,
        roots: rootIds.map((id) => toNode(id, new Set<number>())),
    };
}

export function formatQueryTreeText(view: QueryTreeView): string {
    return formatQueryTree(view, false);
}

export function formatQueryTreeMarkdown(view: QueryTreeView): string {
    return formatQueryTree(view, true);
}

function formatQueryTree(view: QueryTreeView, markdown: boolean): string {
    const lines = [view.name.length > 0 ? `# ${view.name}` : "# Query", view.path, summaryLine(view), ""];

    const walk = (nodes: QueryTreeNode[], depth: number): void => {
        for (const node of nodes) {
            const indent = "  ".repeat(depth);
            const prefix = markdown ? "- " : "";
            lines.push(`${indent}${prefix}${formatNodeLine(node, view.columns)}`);
            walk(node.children, depth + 1);
        }
    };

    walk(view.roots, 0);

    return lines.join("\n");
}

function summaryLine(view: QueryTreeView): string {
    const appearances = countAppearances(view.roots);
    const unique = countUnique(view.roots);
    const count = appearances === unique ? `${unique} work items` : `${appearances} rows · ${unique} work items`;
    const asOf = view.asOf ? ` · as of ${view.asOf}` : "";

    return `${view.queryType} · ${count}${asOf}`;
}

function formatNodeLine(node: QueryTreeNode, columns: QueryTreeColumn[]): string {
    const type = columnValue(node, columns, "System.WorkItemType") ?? "—";
    const title = columnValue(node, columns, "System.Title") ?? "—";
    const head = `${node.id} | ${type} | ${title}`;
    const rest = columns
        .filter((column) => !STRUCTURAL_FIELDS.has(column.referenceName))
        .map((column) => `${column.name}: ${node.values[column.key] ?? "—"}`);

    return rest.length === 0 ? head : `${head} | ${rest.join(" | ")}`;
}

function columnValue(node: QueryTreeNode, columns: QueryTreeColumn[], referenceName: string): string | null {
    const column = columns.find((candidate) => candidate.referenceName === referenceName);

    if (!column) {
        return null;
    }

    return node.values[column.key] ?? null;
}

function valuesFor(
    id: number,
    columns: QueryTreeColumn[],
    fields: Record<string, unknown>
): Record<string, string | null> {
    const values: Record<string, string | null> = {};

    for (const column of columns) {
        values[column.key] =
            column.referenceName === "System.Id" ? String(id) : displayFieldValue(fields[column.referenceName]);
    }

    return values;
}

function columnKeys(columns: QueryColumn[]): QueryTreeColumn[] {
    const used = new Set<string>();

    return columns.map((column) => {
        const key = used.has(column.name) ? `${column.name} (${column.referenceName})` : column.name;
        used.add(key);

        return { ...column, key };
    });
}

function buildForest(relations: QueryRelation[]): { rootIds: number[]; childrenOf: Map<number, number[]> } {
    const childrenOf = new Map<number, number[]>();
    const explicitRoots: number[] = [];
    const seenRoot = new Set<number>();
    const orderedIds: number[] = [];
    const seenId = new Set<number>();

    const note = (id: number): void => {
        if (seenId.has(id)) {
            return;
        }

        seenId.add(id);
        orderedIds.push(id);
    };

    for (const relation of relations) {
        note(relation.targetId);

        if (relation.sourceId == null) {
            if (!seenRoot.has(relation.targetId)) {
                seenRoot.add(relation.targetId);
                explicitRoots.push(relation.targetId);
            }

            continue;
        }

        note(relation.sourceId);
        const children = childrenOf.get(relation.sourceId) ?? [];

        if (!children.includes(relation.targetId)) {
            children.push(relation.targetId);
            childrenOf.set(relation.sourceId, children);
        }
    }

    const childSet = new Set<number>();

    for (const children of childrenOf.values()) {
        for (const childId of children) {
            childSet.add(childId);
        }
    }

    const rootIds = explicitRoots.length > 0 ? [...explicitRoots] : orderedIds.filter((id) => !childSet.has(id));
    const reached = new Set<number>();
    flood(rootIds, childrenOf, reached);

    for (const id of orderedIds) {
        if (childSet.has(id) || reached.has(id)) {
            continue;
        }

        rootIds.push(id);
        flood([id], childrenOf, reached);
    }

    // A cycle no root leads into (1→2→1 alone) is still unreached: every member is someone's
    // child. Seed it from its first item so toNode's cycle guard keeps its rows.
    for (const id of orderedIds) {
        if (reached.has(id)) {
            continue;
        }

        rootIds.push(id);
        flood([id], childrenOf, reached);
    }

    return { rootIds, childrenOf };
}

function flood(ids: number[], childrenOf: Map<number, number[]>, reached: Set<number>): void {
    const pending = [...ids];

    while (pending.length > 0) {
        const id = pending.pop();

        if (id == null || reached.has(id)) {
            continue;
        }

        reached.add(id);

        for (const childId of childrenOf.get(id) ?? []) {
            pending.push(childId);
        }
    }
}

function countAppearances(nodes: QueryTreeNode[]): number {
    let count = 0;

    const walk = (level: QueryTreeNode[]): void => {
        for (const node of level) {
            count += 1;
            walk(node.children);
        }
    };

    walk(nodes);

    return count;
}

function countUnique(nodes: QueryTreeNode[]): number {
    const ids = new Set<number>();

    const walk = (level: QueryTreeNode[]): void => {
        for (const node of level) {
            ids.add(node.id);
            walk(node.children);
        }
    };

    walk(nodes);

    return ids.size;
}

function looksLikeHtml(value: string): boolean {
    return /<\/?[a-z!]/i.test(value);
}

function stripHtml(value: string): string {
    return value
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"');
}
