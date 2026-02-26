/**
 * Azure DevOps CLI Tool - Attachment Download Module
 *
 * Downloads work item attachments with optional filtering by date range
 * and filename prefix/suffix. Used by the workitem command.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Api } from "@app/azure-devops/api";
import type {
    AttachmentFilter,
    AttachmentInfo,
    Relation,
    WorkItemFull,
    WorkItemSettings,
} from "@app/azure-devops/types";
import { filterAttachments, getTaskFilePath } from "@app/azure-devops/utils";
import logger, { consoleLog } from "@app/logger";
import { concurrentMap } from "@app/utils/async";
import { withQueryParams } from "@app/utils/url";

/** Extract attachment GUID from Azure DevOps attachment URL */
function extractAttachmentId(url: string): string {
    const match = url.match(/\/attachments\/([a-f0-9-]+)/i);
    return match?.[1] ?? "";
}

/** Resolve the output directory for a work item's attachments */
function resolveOutputDir(workItemId: number, title: string, settings: WorkItemSettings, override?: string): string {
    if (override) {
        return resolve(override);
    }
    // Default: same directory as the task .md file
    const taskPath = getTaskFilePath(workItemId, title, "md", settings.category, settings.taskFolder);
    return dirname(taskPath);
}

/** Download a single attachment, skipping if already exists with matching size */
async function downloadSingleAttachment(
    api: Api,
    relation: Relation,
    workItemId: number,
    outputDir: string,
): Promise<AttachmentInfo> {
    const attrs = relation.attributes;
    if (!attrs?.name) {
        throw new Error(`Attachment relation for work item #${workItemId} is missing attributes or name`);
    }
    const attachmentId = extractAttachmentId(relation.url);
    const filename = attrs.name;
    const size = attrs.resourceSize ?? 0;
    const createdDate = attrs.resourceCreatedDate ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape/control character matching
    const sanitized = basename(filename).replace(/[<>:"|?*\x00-\x1f]/g, "_");
    const targetPath = join(outputDir, `${workItemId}-${sanitized}`);

    // Skip if already downloaded with matching size
    if (existsSync(targetPath) && size > 0) {
        const stat = statSync(targetPath);
        if (stat.size === size) {
            logger.debug(`[attachments] Skipping ${filename} (already exists, size match)`);
            return {
                id: attachmentId,
                filename,
                size,
                createdDate,
                localPath: targetPath,
                downloaded: false,
            };
        }
        logger.debug(`[attachments] Size mismatch for ${filename}, re-downloading`);
    }

    // Build download URL
    const downloadUrl = withQueryParams(relation.url, { download: "true" });
    const buffer = await api.fetchBinary(downloadUrl, filename);

    // Save to disk
    await Bun.write(targetPath, buffer);
    logger.debug(`[attachments] Downloaded ${filename} (${size} bytes) to ${targetPath}`);

    return {
        id: attachmentId,
        filename,
        size: size || buffer.byteLength,
        createdDate,
        localPath: targetPath,
        downloaded: true,
    };
}

/** Download attachments for a single work item */
async function downloadWorkItemAttachments(
    api: Api,
    item: WorkItemFull,
    settings: WorkItemSettings,
    filter: AttachmentFilter,
): Promise<AttachmentInfo[]> {
    if (!item.relations?.length) {
        return [];
    }

    const filtered = filterAttachments(item.relations, filter);
    if (filtered.length === 0) {
        return [];
    }

    const outputDir = resolveOutputDir(item.id, item.title, settings, filter.outputDir);
    if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
    }

    consoleLog.info(`   Downloading ${filtered.length} attachment(s) for #${item.id}...`);

    const results = await concurrentMap({
        items: filtered,
        fn: async (rel) => downloadSingleAttachment(api, rel, item.id, outputDir),
        onError: (rel, error) =>
            logger.warn(`[attachments] Failed to download ${rel.attributes?.name} for #${item.id}: ${error}`),
    });

    return Array.from(results.values());
}

/**
 * Download attachments for multiple work items matching the filter.
 * Returns Map<workItemId, AttachmentInfo[]> with localPath set on each.
 */
export async function downloadAttachments(
    api: Api,
    items: Map<number, WorkItemFull>,
    settingsMap: Map<number, WorkItemSettings>,
    filter: AttachmentFilter,
): Promise<Map<number, AttachmentInfo[]>> {
    const result = new Map<number, AttachmentInfo[]>();

    for (const [id, item] of items) {
        const settings = settingsMap.get(id);
        if (!settings) {
            continue;
        }
        const attachments = await downloadWorkItemAttachments(api, item, settings, filter);
        if (attachments.length > 0) {
            result.set(id, attachments);
        }
    }

    return result;
}
