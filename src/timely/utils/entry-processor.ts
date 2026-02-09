/**
 * Generic entry processing utility for generating report markdown files
 * Ported from process_november_entries.ts but made generic and reusable
 */

import { join } from "node:path";
import type { TimelyEntry } from "@app/timely/types/api";
import type { Storage } from "@app/utils/storage";
import { getDatesInMonth } from "./date";
import { formatDuration as _formatDuration } from "@app/utils/format";

export interface ProcessedEntry {
    title: string;
    note: string;
    description: string;
    duration: {
        hours: number;
        minutes: number;
        total_minutes: number;
    };
    entries?: TimelyEntry[];
    files?: string[];
    urls?: string[];
    gitOperations?: string[];
}

export interface GroupedEntry {
    title: string;
    entries: ProcessedEntry[];
    totalMinutes: number;
}

/**
 * Check if an entry is work-related based on title, note, and description
 */
function isWorkRelated(entry: any): boolean {
    const text = `${entry.title} ${entry.note || ""} ${entry.description}`.toLowerCase();

    // Include work-related entries
    if (
        text.includes("col-fe") ||
        text.includes("teams") ||
        text.includes("microsoft teams") ||
        text.includes("standup") ||
        text.includes("meeting") ||
        text.includes("chat") ||
        text.includes("cursor") ||
        text.includes("android studio") ||
        text.includes("xcode") ||
        text.includes("warp") ||
        text.includes("gitlab") ||
        text.includes("gitkraken") ||
        text.includes("git ") ||
        text.includes("sentry") ||
        text.includes("kibana") ||
        text.includes("elastic") ||
        text.includes("cprdigital") ||
        text.includes("incident") ||
        text.includes("user story") ||
        text.includes("azure devops") ||
        text.includes("můj čez") ||
        text.includes("error") ||
        text.includes("typeerror") ||
        text.includes("camundaerror") ||
        text.includes("referenceerror") ||
        text.includes("login") ||
        text.includes("authentication") ||
        text.includes("auth") ||
        text.includes("modal") ||
        text.includes("přihlášení") ||
        text.includes("marketing") ||
        text.includes("notification") ||
        text.includes("messages") ||
        text.includes("pn") ||
        text.includes("chrome") ||
        text.includes("finder") ||
        text.includes("anthropic") ||
        text.includes("claude") ||
        text.includes("chatgpt") ||
        text.includes("gpt") ||
        text.includes("aichat") ||
        text.includes("t3") ||
        text.includes("figma") ||
        text.includes("openai")
    ) {
        return true;
    }

    // Exclude clearly non-work entries
    if (
        text.includes("telegram") ||
        text.includes("slack") ||
        text.includes("safari") ||
        text.includes("youtube") ||
        text.includes("reddit") ||
        text.includes("google search") ||
        text.includes("forum") ||
        text.includes("community forum") ||
        text.includes("factory ai") ||
        text.includes("llm-orc") ||
        text.includes("sst/opencode") ||
        text.includes("charmbracelet") ||
        text.includes("mrilikecoding") ||
        text.includes("d1vbcromo72rmd") ||
        text.includes("cap.so") ||
        text.includes("taciturnaxolotl") ||
        text.includes("x-cmd") ||
        text.includes("pkg") ||
        text.includes("dna") ||
        text.includes("inbox") ||
        text.includes("mail") ||
        text.includes("genesi") ||
        text.includes("glm") ||
        text.includes("t3 chat") ||
        text.includes("reservine") ||
        text.includes("tenantscontroller") ||
        text.includes("generatetimeslots") ||
        text.includes("x (4m)") ||
        text.includes("veronika & lucie")
    ) {
        return false;
    }

    return false;
}

/**
 * Get simple group key for an entry
 */
function getSimpleGroupKey(title: string, note: string, description: string): string {
    const text = `${title} ${note} ${description}`.toLowerCase();

    if (title === "Cursor") return "Cursor";
    if (title === "Warp") return "Warp";
    if (title === "GitKraken") return "GitKraken";
    if (title.includes("GitLab")) return "GitLab";
    if (
        title === "Microsoft Teams" ||
        title.includes("Teams") ||
        text.includes("microsoft teams") ||
        title.startsWith("Chat |")
    )
        return "Teams";
    if (title === "Xcode") return "Xcode";
    if (title === "Simulator") return "Simulator";
    if (title === "Android Studio") return "Android Studio";
    if (title === "Brave" || title === "Chrome") return "Brave";
    if (title.includes("Elastic") || title.includes("Kibana")) return "Elastic";
    if (title.includes("Sentry")) return "Sentry";
    if (title === "Figma") return "Figma";
    if (title === "Finder") return "Finder";

    return title;
}

/**
 * Group entries by category
 */
function groupEntries(entries: ProcessedEntry[], detailMode: boolean = false): GroupedEntry[] {
    const groups: { [key: string]: ProcessedEntry[] } = {};

    for (const entry of entries) {
        let groupKey: string;

        if (detailMode) {
            groupKey = getSimpleGroupKey(entry.title, entry.note || "", entry.description || "");
        } else {
            const text = `${entry.title} ${entry.note || ""}`.toLowerCase();

            if (text.includes("standup")) {
                groupKey = "Standup";
            } else if (
                text.includes("login") ||
                text.includes("authentication") ||
                text.includes("auth") ||
                text.includes("modal") ||
                text.includes("přihlášení")
            ) {
                groupKey = "Login";
            } else if (
                text.includes("marketing") ||
                text.includes("notification") ||
                text.includes("messages") ||
                text.includes("pn")
            ) {
                groupKey = "Marketingové PN";
            } else if (
                (text.includes("cursor") || text.includes("vscode") || text.includes("warp")) &&
                text.includes("col-fe")
            ) {
                groupKey = "Vývoj col-fe";
            } else if (text.includes("teams") || text.includes("meeting") || text.includes("schůzka")) {
                groupKey = "Teams schůzky";
            } else if (text.includes("gitlab") || text.includes("git")) {
                groupKey = "Git práce";
            } else if (text.includes("error") || text.includes("sentry") || text.includes("typeerror")) {
                groupKey = "Monitoring chyb";
            } else if (text.includes("android studio") || text.includes("xcode")) {
                groupKey = "Mobilní vývoj";
            } else {
                groupKey = entry.title;
            }
        }

        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(entry);
    }

    return Object.entries(groups)
        .map(([title, entries]) => ({
            title,
            entries,
            totalMinutes: entries.reduce((sum, e) => sum + e.duration.total_minutes, 0),
        }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

/**
 * Format duration from minutes to "Xh Ym" format
 */
function formatDuration(minutes: number): string {
    return _formatDuration(minutes, "min", "hm-always");
}

/**
 * Extract detailed context from an entry
 */
function extractDetailedContext(entry: any): ProcessedEntry {
    const enhanced: ProcessedEntry = {
        title: entry.title,
        note: entry.note || "",
        description: entry.description || "",
        duration: entry.duration,
        entries: entry.entries || [],
        files: [],
        urls: [],
        gitOperations: [],
    };

    // Extract files from Cursor/Warp entries
    if (
        entry.title === "Cursor" ||
        entry.title === "Warp" ||
        entry.title === "Android Studio" ||
        entry.title === "Xcode"
    ) {
        const files = new Set<string>();

        // From main note
        if (entry.note && entry.note.includes("—")) {
            const fileMatch = entry.note.match(/—\s*([^—]+?)(?:\s*—|$)/g);
            if (fileMatch) {
                fileMatch.forEach((match: string) => {
                    const file = match
                        .replace(/^—\s*/, "")
                        .replace(/\s*—.*$/, "")
                        .trim();
                    if (file && !file.includes("Cursor Settings") && !file.includes("●")) {
                        files.add(file);
                    }
                });
            }
        }

        // From entries array
        if (entry.entries && Array.isArray(entry.entries)) {
            entry.entries.forEach((e: TimelyEntry) => {
                if (e.note && e.note.includes("—")) {
                    const parts = e.note
                        .split("—")
                        .map((p: string) => p.trim())
                        .filter((p: string) => p);
                    parts.forEach((part: string) => {
                        if (part && !part.includes("Cursor Settings") && !part.includes("●") && part.includes(".")) {
                            files.add(part);
                        }
                    });
                }

                if (e.sub_entries && Array.isArray(e.sub_entries)) {
                    e.sub_entries.forEach((sub) => {
                        if (sub.note && sub.note.includes("—")) {
                            const parts = sub.note
                                .split("—")
                                .map((p: string) => p.trim())
                                .filter((p: string) => p);
                            parts.forEach((part: string) => {
                                if (
                                    part &&
                                    !part.includes("Cursor Settings") &&
                                    !part.includes("●") &&
                                    part.includes(".")
                                ) {
                                    files.add(part);
                                }
                            });
                        }
                    });
                }
            });
        }

        enhanced.files = Array.from(files);
    }

    // Extract URLs from browser entries
    if (
        entry.title.includes("GitLab") ||
        entry.title.includes("Chrome") ||
        entry.title.includes("Safari") ||
        entry.description.includes("http")
    ) {
        const urls = new Set<string>();

        if (entry.description && (entry.description.includes("http") || entry.description.includes("."))) {
            urls.add(entry.description);
        }

        if (entry.entries && Array.isArray(entry.entries)) {
            entry.entries.forEach((e: TimelyEntry) => {
                if (e.url) urls.add(e.url);
                if (e.description && (e.description.includes("http") || e.description.includes("."))) {
                    urls.add(e.description);
                }
                if (e.note && (e.note.includes("http") || e.note.includes("gitlab") || e.note.includes("sentry"))) {
                    urls.add(e.note);
                }
            });
        }

        enhanced.urls = Array.from(urls);
    }

    // Extract Git operations from GitLab entries
    if (entry.title.includes("GitLab") || entry.title === "GitKraken") {
        const operations: string[] = [];

        if (entry.note) {
            const mrMatch = entry.note.match(/!(\d+)/g);
            if (mrMatch) {
                operations.push(...mrMatch.map((m: string) => `MR${m}`));
            }

            const colMatch = entry.note.match(/COL[-\s]?(\d+)/g);
            if (colMatch) {
                operations.push(...colMatch);
            }

            const branchMatch = entry.note.match(/feature\/([^\s·]+)|branch[:\s]+([^\s·]+)/i);
            if (branchMatch) {
                operations.push(`branch: ${branchMatch[1] || branchMatch[2]}`);
            }

            const noteLower = entry.note.toLowerCase();
            if (noteLower.includes("merge request") || noteLower.includes("!") || noteLower.includes("mr")) {
                operations.push("reviewing MR");
            }
            if (noteLower.includes("merge") && !noteLower.includes("request")) {
                operations.push("merging");
            }
            if (noteLower.includes("rebase")) {
                operations.push("rebasing");
            }
            if (noteLower.includes("commit")) {
                operations.push("committing");
            }
            if (noteLower.includes("push")) {
                operations.push("pushing");
            }
            if (noteLower.includes("pull")) {
                operations.push("pulling");
            }
        }

        enhanced.gitOperations = operations;
    }

    return enhanced;
}

/**
 * Process entries for a single day
 */
async function processDay(
    date: string,
    storage: Storage,
    detailMode: boolean = false
): Promise<{ rawEntries: ProcessedEntry[]; summary: string }> {
    const cacheKey = `suggested_entries/suggested_entries-${date}.json`;

    try {
        // Use a very long TTL since we're reading already cached files
        const rawData = await storage.getRawFile(cacheKey, "3650000 days");
        if (!rawData) {
            return { rawEntries: [], summary: "" };
        }

        const entries = JSON.parse(rawData) as any[];
        const workEntriesRaw = entries.filter((e: any) => isWorkRelated(e));

        const workEntries = workEntriesRaw.map(extractDetailedContext);

        if (workEntries.length === 0) {
            return { rawEntries: [], summary: "" };
        }

        const grouped = groupEntries(workEntries, detailMode);

        const lines = grouped.map((group) => {
            if (detailMode) {
                const allItems: string[] = [];

                for (const entry of group.entries) {
                    if (entry.entries && Array.isArray(entry.entries)) {
                        entry.entries.forEach((e: TimelyEntry) => {
                            if (e.note && e.note !== entry.title && !allItems.includes(e.note)) {
                                allItems.push(e.note);
                            }

                            if (e.sub_entries && Array.isArray(e.sub_entries)) {
                                e.sub_entries.forEach((sub) => {
                                    if (sub.note && !allItems.includes(sub.note)) {
                                        allItems.push(sub.note);
                                    }
                                });
                            }
                        });
                    }

                    if (entry.note && entry.note !== entry.title && !allItems.includes(entry.note)) {
                        allItems.push(entry.note);
                    }
                }

                const durationText = formatDuration(group.totalMinutes);
                const itemsList = allItems.length > 0 ? `\n  ${allItems.map((item) => `- ${item}`).join("\n  ")}` : "";

                return `- ${group.title} (${durationText})${itemsList}`;
            } else {
                const descriptions: string[] = [];
                const allFiles: string[] = [];
                const allUrls: string[] = [];
                const allGitOps: string[] = [];
                let hasShortEntries = false;

                for (const entry of group.entries) {
                    const entryText = `${entry.title} ${entry.note || ""} ${entry.description}`.toLowerCase();
                    if (entryText.length < 10) {
                        hasShortEntries = true;
                    }

                    if (entry.files && entry.files.length > 0) {
                        allFiles.push(...entry.files);
                    }

                    if (entry.urls && entry.urls.length > 0) {
                        allUrls.push(...entry.urls);
                    }

                    if (entry.gitOperations && entry.gitOperations.length > 0) {
                        allGitOps.push(...entry.gitOperations);
                    }

                    if (entry.note && entry.note !== entry.title) {
                        const note = entry.note;
                        if (note.includes("COL-") || note.includes("MR") || note.includes("!")) {
                            const mrMatch = note.match(/COL[-\s]?(\d+)/);
                            if (mrMatch) {
                                descriptions.push(`COL-${mrMatch[1]}`);
                            }
                        } else if (note.toLowerCase().includes("login")) {
                            descriptions.push("login funkcionalita");
                        } else if (note.toLowerCase().includes("marketing")) {
                            descriptions.push("marketing notifications");
                        } else if (note.includes("TypeError") || note.includes("error")) {
                            descriptions.push("řešení chyb");
                        } else if (note.length < 100) {
                            descriptions.push(note);
                        }
                    } else if (entry.title.includes("Cursor") && entry.description.includes("col-fe")) {
                        descriptions.push("vývoj ve VS Code");
                    }
                }

                const uniqueDescriptions = [...new Set(descriptions)];
                const uniqueFiles = [...new Set(allFiles)].slice(0, 5);
                const uniqueUrls = [...new Set(allUrls)].slice(0, 3);
                const uniqueGitOps = [...new Set(allGitOps)];

                const contextParts: string[] = [];
                if (uniqueFiles.length > 0) {
                    contextParts.push(`files: ${uniqueFiles.join(", ")}`);
                }
                if (uniqueUrls.length > 0) {
                    contextParts.push(`urls: ${uniqueUrls.join(", ")}`);
                }
                if (uniqueGitOps.length > 0) {
                    contextParts.push(`git: ${uniqueGitOps.join(", ")}`);
                }

                const descriptionText = uniqueDescriptions.length > 0 ? ` - ${uniqueDescriptions.join(", ")}` : "";
                const contextText = contextParts.length > 0 ? ` [${contextParts.join(" | ")}]` : "";
                const durationText = formatDuration(group.totalMinutes);
                const maybeMarker = hasShortEntries ? " [maybe related]" : "";

                return `- ${group.title}${descriptionText}${contextText}${maybeMarker} (${durationText})`;
            }
        });

        return { rawEntries: workEntries, summary: lines.join("\n") };
    } catch {
        return { rawEntries: [], summary: "" };
    }
}

/**
 * Format date for display (DD. MM. YYYY)
 */
function formatDateForDisplay(date: string, year: number, month: number): string {
    const dayNum = parseInt(date.split("-")[2]);
    return `${dayNum}. ${month}. ${year}`;
}

/**
 * Generate report markdown for a given month
 * @param monthArg - Month in YYYY-MM format
 * @param storage - Storage instance
 * @param detailMode - Whether to use detailed mode
 * @returns Markdown content and absolute file path
 */
export async function generateReportMarkdown(
    monthArg: string,
    storage: Storage,
    detailMode: boolean = false
): Promise<{ content: string; filePath: string }> {
    const [year, month] = monthArg.split("-").map(Number);
    const dates = getDatesInMonth(monthArg);

    const allEntries: { [date: string]: ProcessedEntry[] } = {};
    const allSummaries: { [date: string]: string } = {};

    for (const date of dates) {
        const { rawEntries, summary } = await processDay(date, storage, detailMode);
        if (summary.trim()) {
            allEntries[date] = rawEntries;
            allSummaries[date] = summary;
        }
    }

    // Generate markdown content
    const mdLines: string[] = [];

    // Don't add header for detailed-summary format (matches entries-2025-09.md format)
    if (!detailMode) {
        mdLines.push("# SUMMARIES\n");
    }

    for (const [date, summary] of Object.entries(allSummaries)) {
        mdLines.push(`## ${formatDateForDisplay(date, year, month)}\n`);
        mdLines.push(summary);
        mdLines.push("");
    }

    const content = mdLines.join("\n");

    // Save to cache with different filename for detailed mode
    const cacheKey = detailMode ? `entries-${monthArg}-detailed-summary.md` : `entries-${monthArg}-summary.md`;
    const ttl = "90 days";
    await storage.putRawFile(cacheKey, content, ttl);

    // Get absolute path
    const filePath = join(storage.getCacheDir(), cacheKey);

    return { content, filePath };
}
