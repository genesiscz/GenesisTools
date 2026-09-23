/**
 * Azure DevOps work items named by merge requests, read through `tools azure-devops workitem`.
 * That tool already returns fields, relations and comments in one call and holds the login, and
 * it finds its own organisation config relative to the checkout, so the spawn runs there.
 *
 * Off unless `workItems.idPattern` is set in the gitlab config.
 */

import type { WorkItemConfig } from "@app/gitlab/lib/config";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface AdoComment {
    id: number;
    author: string;
    date: string;
    text: string;
}

export interface AdoWorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
    url: string;
    assignee: string | null;
    tags: string[];
    created: string;
    changed: string;
    changedBy: string | null;
    description: string;
    parentId: number | null;
    comments: AdoComment[];
    lastCommentDate: string | null;
    /** `Microsoft.VSTS.Common.ClosedDate`, set once the item reached Closed. */
    closedDate: string | null;
    closedBy: string | null;
    /** `System.Reason`, for example "Moved out of state Testing" or "Fixed and verified". */
    reason: string | null;
    /** The configured `workItems.environmentField`: the environment the item was found or verified on. */
    environment: string | null;
    /** The configured `workItems.mergeRequestField`: the MR URL somebody typed into the item. */
    mergeRequestUrl: string | null;
}

export interface AdoFetchError {
    id: number;
    error: string;
}

export type AdoResult = { ok: true; item: AdoWorkItem } | { ok: false; error: AdoFetchError };

interface RawWorkItem {
    id: number;
    title: string;
    state: string;
    changed: string;
    created?: string;
    assignee?: string | null;
    tags?: string | null;
    description?: string | null;
    changedBy?: string | null;
    url: string;
    rawFields?: Record<string, unknown>;
    comments?: Array<{ id: number; author: string; date: string; text: string }>;
}

/** The configured id pattern as a global regex; the first capture group (or the whole match) is the id. */
export function workItemIdRegex(pattern: string): RegExp {
    return new RegExp(pattern, "g");
}

/** Every distinct id across the sources, in order of first appearance. Empty when no pattern is configured. */
export function extractWorkItemIds(pattern: string | null, ...sources: Array<string | null | undefined>): number[] {
    if (!pattern) {
        return [];
    }

    const regex = workItemIdRegex(pattern);
    const ids: number[] = [];

    for (const source of sources) {
        for (const match of source?.matchAll(regex) ?? []) {
            const id = Number(match[1] ?? match[0]);

            if (Number.isInteger(id) && id > 0 && !ids.includes(id)) {
                ids.push(id);
            }
        }
    }

    return ids;
}

/** Web URL of an item from `workItems.urlTemplate`, or null when none is configured. */
export function workItemUrl(config: Pick<WorkItemConfig, "urlTemplate">, id: number | string): string | null {
    return config.urlTemplate ? config.urlTemplate.replaceAll("{id}", String(id)) : null;
}

/** `[123](url)` when a URL is known, else the bare id. */
export function workItemLink(config: Pick<WorkItemConfig, "urlTemplate">, id: number): string {
    const url = workItemUrl(config, id);

    return url ? `[${id}](${url})` : String(id);
}

export function stripHtml(html: string | null | undefined): string {
    if (!html) {
        return "";
    }

    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(div|p|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function stringField(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function toWorkItem(raw: RawWorkItem, config: WorkItemConfig): AdoWorkItem {
    const fields = raw.rawFields ?? {};
    const parent = fields["System.Parent"];
    const comments = (raw.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author,
        date: c.date,
        text: stripHtml(c.text),
    }));
    const lastComment = comments.reduce<string | null>((max, c) => (max && max > c.date ? max : c.date), null);
    const closedBy = fields["Microsoft.VSTS.Common.ClosedBy"];
    const closedByName =
        typeof closedBy === "object" && closedBy !== null && "displayName" in closedBy
            ? closedBy.displayName
            : closedBy;

    return {
        id: raw.id,
        title: raw.title,
        type: String(fields["System.WorkItemType"] ?? "unknown"),
        state: raw.state,
        url: workItemUrl(config, raw.id) ?? raw.url,
        assignee: raw.assignee ?? null,
        tags: (raw.tags ?? "")
            .split(";")
            .map((t) => t.trim())
            .filter(Boolean),
        created: raw.created ?? "",
        changed: raw.changed,
        changedBy: raw.changedBy ?? null,
        description: stripHtml(raw.description),
        parentId: typeof parent === "number" ? parent : null,
        comments,
        lastCommentDate: lastComment,
        closedDate: stringField(fields["Microsoft.VSTS.Common.ClosedDate"]),
        closedBy: stringField(closedByName),
        reason: stringField(fields["System.Reason"]),
        environment: config.environmentField ? stringField(fields[config.environmentField]) : null,
        mergeRequestUrl: config.mergeRequestField ? stringField(fields[config.mergeRequestField]) : null,
    };
}

export interface FetchAdoOptions {
    config: WorkItemConfig;
    /** Bypass the azure-devops on-disk cache. Default true: cleanup decisions need the live state. */
    force?: boolean;
    /** The checkout whose `.claude/azure/config.json` names the organisation. */
    cwd?: string;
}

export async function fetchAdoWorkItem(id: number, options: FetchAdoOptions): Promise<AdoResult> {
    const args = ["azure-devops", "workitem", String(id), "-f", "json"];
    if (options.force !== false) {
        args.push("--force");
    }

    logger.debug({ id, cwd: options.cwd }, "gitlab: reading work item via tools azure-devops");
    const result = await execTool(args, { cwd: options.cwd });
    const stdout = result.stdout.trim();

    if (result.exitCode !== 0 || !(stdout.startsWith("{") || stdout.startsWith("["))) {
        const text = (result.stderr || result.stdout).replace(/\s+/g, " ").trim();

        return { ok: false, error: { id, error: text.slice(0, 400) || `exit ${result.exitCode}` } };
    }

    try {
        const parsed: unknown = SafeJSON.parse(stdout, { strict: true });
        const raw = Array.isArray(parsed) ? parsed[0] : parsed;

        if (!raw || typeof raw !== "object" || !("id" in raw)) {
            return { ok: false, error: { id, error: "empty result" } };
        }

        return { ok: true, item: toWorkItem(raw as RawWorkItem, options.config) };
    } catch (e: unknown) {
        return { ok: false, error: { id, error: `unparseable JSON: ${e instanceof Error ? e.message : String(e)}` } };
    }
}

export interface AdoResolution {
    /** The item the MR points at. */
    item: AdoWorkItem;
    /** The parent when `item` is a Task; the story, bug or feature above it carries the business state. */
    effective: AdoWorkItem;
    parentError: AdoFetchError | null;
}

/** Fetch the item and, for a Task, climb one level to the item that carries the business state. */
export async function resolveAdo(id: number, options: FetchAdoOptions): Promise<AdoResolution | AdoFetchError> {
    const first = await fetchAdoWorkItem(id, options);
    if (!first.ok) {
        return first.error;
    }

    const item = first.item;
    if (item.type !== "Task" || item.parentId === null) {
        return { item, effective: item, parentError: null };
    }

    const parent = await fetchAdoWorkItem(item.parentId, options);
    if (!parent.ok) {
        return { item, effective: item, parentError: parent.error };
    }

    return { item, effective: parent.item, parentError: null };
}
