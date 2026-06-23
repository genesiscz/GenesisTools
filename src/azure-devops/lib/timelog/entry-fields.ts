import type { PrecheckResult } from "@app/azure-devops/workitem-precheck";

export interface TimelogEntryTitleFields {
    workItemTitle?: string;
    workItemName?: string;
    _workitemTitle?: string;
}

const PREPARE_IMPORT_ENTRY_ORDER = [
    "_id",
    "_status",
    "workItemId",
    "workItemTitle",
    "date",
    "hours",
    "minutes",
    "timeType",
    "comment",
] as const;

const IMPORT_ENTRY_ORDER = ["workItemId", "workItemTitle", "date", "hours", "minutes", "timeType", "comment"] as const;

export function readEntryWorkItemTitle(entry: TimelogEntryTitleFields): string | undefined {
    const title = entry.workItemTitle?.trim() || entry.workItemName?.trim() || entry._workitemTitle?.trim();

    if (!title) {
        return undefined;
    }

    return title;
}

export function workItemTitleFromPrecheck(result: PrecheckResult): string | undefined {
    if (result.status === "redirect") {
        return result.redirectTitle ?? result.originalTitle;
    }

    return result.originalTitle || undefined;
}

export function normalizeTimelogEntryKeys<T extends object>(entry: T): T {
    const record = entry as Record<string, unknown>;
    const order = "_id" in record ? PREPARE_IMPORT_ENTRY_ORDER : IMPORT_ENTRY_ORDER;
    const normalized: Record<string, unknown> = {};
    const used = new Set<string>();

    for (const key of order) {
        if (key in record) {
            normalized[key] = record[key];
            used.add(key);
        }
    }

    for (const [key, value] of Object.entries(record)) {
        if (!used.has(key) && key !== "workItemName" && key !== "_workitemTitle") {
            normalized[key] = value;
        }
    }

    return normalized as T;
}

export function normalizeTimelogEntries<T extends object>(entries: T[]): T[] {
    return entries.map((entry) => normalizeTimelogEntryKeys(entry));
}

export function setEntryWorkItemTitle<T extends TimelogEntryTitleFields>(entry: T, title: string): T {
    const {
        workItemName: _workItemName,
        _workitemTitle,
        ...rest
    } = entry as T & {
        workItemName?: string;
        _workitemTitle?: string;
    };

    return normalizeTimelogEntryKeys({
        ...rest,
        workItemTitle: title,
    }) as T;
}
