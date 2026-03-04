# Azure DevOps Inline Images from Work Items

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically download inline images embedded in work item HTML descriptions/comments and rewrite markdown references to use local paths, so images are viewable offline and by Claude's multimodal Read tool.

**Architecture:** Parse `<img>` tags from work item HTML (description + comments), download Azure DevOps attachment images via authenticated `api.fetchBinary()`, save with `<wid>-<filename>` naming convention alongside work item files, and rewrite URLs in the markdown output. Add `--images` CLI flag. Update the azure-devops skill to instruct image loading during analysis.

**Tech Stack:** TypeScript/Bun, existing Azure DevOps API client (`api.fetchBinary()`), Turndown (HTML-to-MD), node:url for URL parsing.

---

## Context

When work items have inline images (screenshots pasted into descriptions/comments), the current tool only converts them to `![](https://dev.azure.com/...)` markdown links pointing to remote URLs. These require authentication and aren't available offline. Users must manually extract UUIDs, construct curl commands with bearer tokens, and download each image. This feature automates that workflow.

**Image URL format in Azure DevOps HTML:**
```html
<img src="https://dev.azure.com/{org}/{project}/_apis/wit/attachments/{uuid}?fileName=image.png">
```

**Target directory structure:**
```
.claude/azure/tasks/<category>/<wid>/<wid>-<slug>.md       # references local images
.claude/azure/tasks/<category>/<wid>/<wid>-<slug>.json     # original URLs preserved
.claude/azure/tasks/<category>/<wid>/<wid>-<imagename>.png # downloaded image
```

---

## Prerequisite: Branch Setup

```bash
git checkout master
git checkout -b feat/azure-devops-images --no-track
```

---

### Task 1: Create inline image extraction and URL rewriting module

**Files:**
- Create: `src/azure-devops/inline-images.ts`

**Step 1: Create the inline-images module**

```typescript
/**
 * Azure DevOps CLI - Inline image extraction and download from work item HTML
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "@app/azure-devops/api";
import logger from "@app/logger";
import { concurrentMap } from "@app/utils/async";

/** Parsed inline image reference from HTML */
export interface InlineImageRef {
    originalUrl: string;
    attachmentId: string;
    fileName: string;
    localFileName: string;
}

/** Result of downloading an inline image */
export interface InlineImageResult extends InlineImageRef {
    localPath: string;
    downloaded: boolean;
    size: number;
}

const ATTACHMENT_URL_PATTERN = /\/_apis\/wit\/attachments\/([a-f0-9-]+)/i;
const IMG_SRC_PATTERN = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

/**
 * Extract Azure DevOps attachment image URLs from HTML content.
 * Returns deduplicated list of image references.
 */
export function extractInlineImageUrls(html: string, workItemId: number): InlineImageRef[] {
    if (!html) {
        return [];
    }

    const seen = new Set<string>();
    const images: InlineImageRef[] = [];

    for (const match of html.matchAll(IMG_SRC_PATTERN)) {
        const url = match[1];

        if (seen.has(url)) {
            continue;
        }

        seen.add(url);
        const attachmentMatch = url.match(ATTACHMENT_URL_PATTERN);

        if (!attachmentMatch) {
            continue; // Skip non-Azure DevOps images
        }

        const attachmentId = attachmentMatch[1];
        const fileName = extractFileName(url, attachmentId);
        const localFileName = `${workItemId}-${fileName}`;

        images.push({ originalUrl: url, attachmentId, fileName, localFileName });
    }

    return images;
}

/** Extract filename from URL query params or generate from UUID */
function extractFileName(url: string, attachmentId: string): string {
    try {
        const parsed = new URL(url);
        const fileName = parsed.searchParams.get("fileName");

        if (fileName) {
            return sanitizeFileName(fileName);
        }
    } catch {
        // Invalid URL, fall through
    }

    return `image-${attachmentId.slice(0, 8)}.png`;
}

/** Sanitize filename for filesystem */
function sanitizeFileName(name: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char removal
    return name.replace(/[<>:"|?*\x00-\x1f]/g, "_");
}

/**
 * Download inline images to the output directory.
 * Skips already-existing files with matching content.
 * Returns map of originalUrl -> localFileName for URL rewriting.
 */
export async function downloadInlineImages(
    api: Api,
    images: InlineImageRef[],
    outputDir: string
): Promise<Map<string, string>> {
    if (images.length === 0) {
        return new Map();
    }

    const urlMap = new Map<string, string>();
    const results = await concurrentMap({
        items: images,
        fn: async (img) => {
            const targetPath = join(outputDir, img.localFileName);

            // Skip if already exists
            if (existsSync(targetPath)) {
                const stat = statSync(targetPath);

                if (stat.size > 0) {
                    logger.debug(`[inline-images] Skipping ${img.localFileName} (already exists)`);
                    urlMap.set(img.originalUrl, img.localFileName);
                    return;
                }
            }

            try {
                const buffer = await api.fetchBinary(img.originalUrl, img.localFileName);
                await Bun.write(targetPath, buffer);
                logger.debug(`[inline-images] Downloaded ${img.localFileName} (${buffer.byteLength} bytes)`);
                urlMap.set(img.originalUrl, img.localFileName);
            } catch (error) {
                logger.warn(`[inline-images] Failed to download ${img.localFileName}: ${error}`);
            }
        },
        onError: (img, error) => {
            logger.warn(`[inline-images] Error downloading ${img.localFileName}: ${error}`);
        },
    });

    return urlMap;
}

/**
 * Rewrite image URLs in HTML to use local filenames.
 * Used before HTML-to-Markdown conversion so generated markdown references local files.
 */
export function rewriteImageUrls(html: string, urlMap: Map<string, string>): string {
    if (!html || urlMap.size === 0) {
        return html;
    }

    let result = html;

    for (const [originalUrl, localFileName] of urlMap) {
        result = result.replaceAll(originalUrl, localFileName);
    }

    return result;
}
```

**Step 2: Commit**

```bash
git add src/azure-devops/inline-images.ts
git commit -m "feat(azure-devops): add inline image extraction and download module"
```

---

### Task 2: Integrate inline images into handleWorkItem flow

**Files:**
- Modify: `src/azure-devops/commands/workitem.ts` (lines 146-213 for `generateWorkItemMarkdown`, lines 341-408 for Phase 2.5/3)

**Step 1: Update generateWorkItemMarkdown to accept imageMap**

In `workitem.ts`, modify the `generateWorkItemMarkdown` function signature to accept an optional `imageMap` parameter. When provided, rewrite image URLs in description and comment HTML before converting to markdown.

```typescript
// Add import at top of file
import { downloadInlineImages, extractInlineImageUrls, rewriteImageUrls } from "@app/azure-devops/inline-images";

// Modify generateWorkItemMarkdown signature (line 146)
function generateWorkItemMarkdown(item: WorkItemFull, imageMap?: Map<string, string>): string {
    // ... existing code until description section (line 165-170)

    if (item.description) {
        lines.push("");
        lines.push("## Description");
        lines.push("");
        const descHtml = imageMap ? rewriteImageUrls(item.description, imageMap) : item.description;
        lines.push(htmlToMarkdown(descHtml));
    }

    // ... existing code until comments section (line 200-210)

    if (item.comments.length > 0) {
        lines.push("");
        lines.push(`## Comments (${item.comments.length})`);
        lines.push("");
        for (const comment of item.comments) {
            lines.push(`### ${comment.author} - ${new Date(comment.date).toLocaleString()}`);
            lines.push("");
            const commentHtml = imageMap ? rewriteImageUrls(comment.text, imageMap) : comment.text;
            lines.push(htmlToMarkdown(commentHtml));
            lines.push("");
        }
    }

    return lines.join("\n");
}
```

**Step 2: Add image download step in handleWorkItem**

Between Phase 2.5 (attachment download) and Phase 3 (save to disk), add inline image download. After Phase 3 save, pass the imageMap to `generateWorkItemMarkdown`.

In the Phase 3 loop (around line 350-408), for each fetched item:

```typescript
// After attachments download (Phase 2.5), before Phase 3 save loop:
// Phase 2.6: Download inline images if requested
const inlineImageMaps = new Map<number, Map<string, string>>();
if (downloadImages) {
    const allItems = new Map<number, WorkItemFull>([...cachedResults, ...fetchedItems]);

    for (const [id, item] of allItems) {
        const settings = settingsMap.get(id);

        if (!settings) {
            continue;
        }

        // Extract image refs from description + comments
        const imageRefs = [
            ...extractInlineImageUrls(item.description ?? "", id),
            ...item.comments.flatMap((c) => extractInlineImageUrls(c.text, id)),
        ];

        if (imageRefs.length === 0) {
            continue;
        }

        const outputDir = dirname(getTaskFilePath(id, item.title, "md", settings.category, settings.taskFolder));

        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        log(`   Downloading ${imageRefs.length} inline image(s) for #${id}...`);
        const urlMap = await downloadInlineImages(api, imageRefs, outputDir);
        inlineImageMaps.set(id, urlMap);
    }
}

// In Phase 3: pass imageMap to generateWorkItemMarkdown (line 384)
const imageMap = inlineImageMaps.get(id);
writeFileSync(mdPath, generateWorkItemMarkdown(item, imageMap));
```

Also update the cached-item markdown regeneration: when `downloadImages` is true, also regenerate markdown for cached items that now have images.

**Step 3: Add `--images` flag to registerWorkitemCommand**

In `registerWorkitemCommand` (around line 462), add:
```typescript
.option("--images", "Download inline images from description and comments")
```

And pass it through to `handleWorkItem` via a new parameter.

**Step 4: Also propagate `--images` to query `--download-workitems` flow**

In `src/azure-devops/commands/query.ts`, pass the `--images` flag through when `--download-workitems` is used.

**Step 5: Commit**

```bash
git add src/azure-devops/commands/workitem.ts src/azure-devops/commands/query.ts
git commit -m "feat(azure-devops): integrate inline image download into workitem command"
```

---

### Task 3: Also update formatWorkItemAI to report inline images

**Files:**
- Modify: `src/azure-devops/commands/workitem.ts` (lines 49-144 for `formatWorkItemAI`)

**Step 1: Add inline images section to AI format output**

After the attachments section in `formatWorkItemAI`, add an inline images section showing downloaded images with their local paths. This helps Claude know what images are available to Read.

```typescript
// In formatWorkItemAI, after attachments section, add:
if (inlineImages && inlineImages.size > 0) {
    lines.push("");
    lines.push(`## Inline Images (${inlineImages.size} downloaded)`);
    for (const [url, localFile] of inlineImages) {
        const dir = dirname(taskPath);
        lines.push(`- ${localFile} → ${join(dir, localFile)}`);
    }
}
```

**Step 2: Commit**

```bash
git add src/azure-devops/commands/workitem.ts
git commit -m "feat(azure-devops): show inline image paths in AI format output"
```

---

### Task 4: Update the azure-devops skill

**Files:**
- Modify: `plugins/genesis-tools/skills/azure-devops/SKILL.md`

**Step 1: Add `--images` flag to Options table**

| `--images` | Download inline images from description/comments |

**Step 2: Add Inline Images section after Attachment Output Paths**

```markdown
### Inline Image Output Paths

Inline images (screenshots embedded in description/comments HTML) are downloaded when `--images` is provided.

- **Default**: Same folder as task file: `.claude/azure/tasks/<taskid>-<imagename>.png`
- With `--task-folders`: `.claude/azure/tasks/<id>/<taskid>-<imagename>.png`
- Images are referenced in the `.md` file with relative paths

**Recommended**: Use `--task-folders --images` together to keep each work item's files organized in its own directory.
```

**Step 3: Update Analyze Work Items section**

Add step to load images after fetching work items:

```markdown
### Analyze Work Items

When user says "analyze workitem/task X" or "analyze tasks from query Y":

1. Fetch work item(s) with images:
   ```bash
   tools azure-devops workitem <ids> --category <cat> --task-folders --images
   ```

2. Read the generated `.md` file for each work item

3. **Read inline images** - Check if the work item directory contains image files:
   ```bash
   ls .claude/azure/tasks/<category>/<id>/<id>-*.{png,jpg,gif,jpeg} 2>/dev/null
   ```
   If images exist, use the **Read tool** to view each image file. This gives visual context for:
   - Bug screenshots showing the issue
   - Design mockups showing expected behavior
   - UI comparisons (current vs expected)

4. Spawn **Explore agent** with visual context:
   ```
   Analyze codebase for Azure DevOps work item:

   **#{id}: {title}**
   State: {state} | Severity: {severity}

   **Description:** {description}
   **Visual Context:** {describe what the images show}
   ...
   ```
```

**Step 4: Add examples row**

| "Get task 261575 with screenshots" | `tools azure-devops workitem 261575 --task-folders --images` |
| "Analyze bug with images" | Fetch with `--images` -> Read images -> Explore agent with visual context |

**Step 5: Commit**

```bash
git add plugins/genesis-tools/skills/azure-devops/SKILL.md
git commit -m "docs(azure-devops): update skill with --images flag and image loading instructions"
```

---

### Task 5: Handle cached work items with newly requested images

**Files:**
- Modify: `src/azure-devops/commands/workitem.ts`

**Step 1: Regenerate markdown for cached items when images are newly downloaded**

When `--images` is passed but the work item was served from cache, we still need to:
1. Download inline images (they might not exist locally yet)
2. Regenerate the `.md` file with local image references

In the cached items path, after the main Phase 3 loop, add a loop for cached items that need image processing:

```typescript
// Phase 3.5: Handle cached items that need image download + markdown regeneration
if (downloadImages) {
    for (const [id, item] of cachedResults) {
        const imageMap = inlineImageMaps.get(id);

        if (!imageMap || imageMap.size === 0) {
            continue;
        }

        const settings = settingsMap.get(id)!;
        const mdPath = getTaskFilePath(id, item.title, "md", settings.category, settings.taskFolder);
        writeFileSync(mdPath, generateWorkItemMarkdown(item, imageMap));
        log(`   Regenerated markdown for #${id} with ${imageMap.size} inline image(s)`);
    }
}
```

**Step 2: Commit**

```bash
git add src/azure-devops/commands/workitem.ts
git commit -m "fix(azure-devops): regenerate cached item markdown when images are newly downloaded"
```

---

## Verification

1. **Manual test with a known work item that has inline images:**
   ```bash
   tools azure-devops workitem 272325 --task-folders --images --category login --force
   ```

   Expected:
   - Images downloaded to `.claude/azure/tasks/login/272325/272325-*.png`
   - Markdown file references images with relative paths like `![](272325-image.png)`
   - JSON file still has original Azure DevOps URLs
   - AI format output lists downloaded images with full paths

2. **Verify markdown image references:**
   ```bash
   grep '!\[' .claude/azure/tasks/login/272325/*.md
   ```
   Should show local filenames, not `https://dev.azure.com/...` URLs.

3. **Verify images are readable by Claude:**
   Use the Read tool on a downloaded `.png` file to confirm it's a valid image.

4. **TypeScript check:**
   ```bash
   tsgo --noEmit 2>&1 | rg "azure-devops"
   ```

5. **Test without --images flag:** Verify existing behavior is unchanged (no images downloaded, markdown has remote URLs).

6. **Test with cached items:** Run the same command twice - second run should skip downloads but still generate correct markdown.

---

## Critical Files Reference

| File | Purpose |
|------|---------|
| `src/azure-devops/inline-images.ts` | NEW - Image extraction, download, URL rewriting |
| `src/azure-devops/commands/workitem.ts` | MODIFY - Integrate image download, update markdown gen |
| `src/azure-devops/commands/query.ts` | MODIFY - Pass --images flag through |
| `src/azure-devops/api.ts:282-302` | REUSE - `fetchBinary()` for authenticated downloads |
| `src/azure-devops/commands/attachments.ts` | REFERENCE - Pattern for download + skip logic |
| `src/azure-devops/task-files.ts` | REUSE - `getTaskFilePath()`, `getTasksDir()` |
| `src/utils/markdown/html-to-md.ts` | REUSE - `htmlToMarkdown()` (unchanged) |
| `src/utils/async.ts` | REUSE - `concurrentMap()` for parallel downloads |
| `plugins/genesis-tools/skills/azure-devops/SKILL.md` | MODIFY - Skill docs |
