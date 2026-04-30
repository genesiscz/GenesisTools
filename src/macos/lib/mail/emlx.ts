import { Database } from "bun:sqlite";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { htmlToMarkdown } from "@app/utils/markdown/html-to-md";
import { ENVELOPE_INDEX_PATH } from "./constants";
import { extractRowidFromEmlxPath } from "./spotlight";

const MAIL_V10_DIR = join(homedir(), "Library/Mail/V10");

export interface MailBodyParts {
    raw: string;
    html: string;
    markdown: string;
    text: string;
}

function removeNonContentHtml(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<\/?(?:table|thead|tbody|tfoot|tr|td|th)[^>]*>/gi, "\n");
}

function stripHtmlToText(html: string): string {
    return removeNonContentHtml(html)
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#\d+;/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function readMimeContentFromEmlx(content: Buffer): Buffer | null {
    const newlineIdx = content.indexOf(10); // '\n'

    if (newlineIdx < 0) {
        return null;
    }

    // First line is byte count of MIME content
    const firstLine = content.subarray(0, newlineIdx).toString().trim();
    const byteCount = Number.parseInt(firstLine, 10);

    if (!Number.isNaN(byteCount) && byteCount > 0) {
        return content.subarray(newlineIdx + 1, newlineIdx + 1 + byteCount);
    }

    // Fallback: read everything after first line
    return content.subarray(newlineIdx + 1);
}

export async function parseEmlxBodyPartsFromFile(filePath: string): Promise<MailBodyParts | null> {
    const content = Buffer.from(await Bun.file(filePath).bytes());
    const mimeContent = readMimeContentFromEmlx(content);

    if (!mimeContent) {
        return null;
    }

    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(mimeContent);
    const raw = mimeContent.toString("utf-8");
    const html = typeof parsed.html === "string" ? parsed.html : "";
    const markdown = html ? htmlToMarkdown(removeNonContentHtml(html)) : (parsed.text ?? "").trim();
    const text = (parsed.text ?? (markdown || stripHtmlToText(html))).trim();

    if (!raw && !html && !markdown && !text) {
        return null;
    }

    return { raw, html, markdown, text };
}

export class EmlxBodyExtractor {
    /** Map<rowid, absolute path to .emlx or .partial.emlx> */
    private pathIndex: Map<number, string>;
    /** Envelope Index DB for summaries table */
    private summaryDb: Database | null = null;
    private summaryDbInitAttempted = false;

    private constructor(pathIndex: Map<number, string>) {
        this.pathIndex = pathIndex;
    }

    /**
     * Create extractor by scanning all Messages/ directories.
     * Takes ~0.7s for ~4000 directories, builds Map<rowid, path>.
     */
    static async create(): Promise<EmlxBodyExtractor> {
        const pathIndex = new Map<number, string>();
        const startMs = performance.now();

        function scanDir(dir: string): void {
            let entries: Dirent[];

            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const name = String(entry.name);
                const fullPath = join(dir, name);

                if (entry.isDirectory()) {
                    scanDir(fullPath);
                } else if (name.endsWith(".emlx")) {
                    const rowid = extractRowidFromEmlxPath(name);

                    if (rowid !== null) {
                        const isPartial = name.endsWith(".partial.emlx");

                        // Prefer .emlx over .partial.emlx
                        if (!pathIndex.has(rowid) || !isPartial) {
                            pathIndex.set(rowid, fullPath);
                        }
                    }
                }
            }
        }

        if (existsSync(MAIL_V10_DIR)) {
            scanDir(MAIL_V10_DIR);
        }

        const elapsed = performance.now() - startMs;
        logger.debug(`EmlxBodyExtractor: indexed ${pathIndex.size} messages in ${elapsed.toFixed(0)}ms`);

        return new EmlxBodyExtractor(pathIndex);
    }

    get indexedCount(): number {
        return this.pathIndex.size;
    }

    getEmlxPath(rowid: number): string | null {
        return this.pathIndex.get(rowid) ?? null;
    }

    /**
     * L1: Try summaries table in Envelope Index (instant, ~20% hit rate)
     */
    getSummary(rowid: number): string | null {
        if (!this.summaryDb && !this.summaryDbInitAttempted) {
            this.summaryDbInitAttempted = true;

            try {
                this.summaryDb = new Database(ENVELOPE_INDEX_PATH, { readonly: true });
            } catch {
                return null;
            }
        }

        if (!this.summaryDb) {
            return null;
        }

        try {
            const row = this.summaryDb
                .query(
                    "SELECT sum.summary FROM messages m JOIN summaries sum ON m.summary = sum.ROWID WHERE m.ROWID = ?"
                )
                .get(rowid) as { summary: string } | null;

            if (row?.summary && row.summary.length > 0) {
                return row.summary;
            }
        } catch (err) {
            logger.debug(`Failed to get summary for rowid ${rowid}: ${err}`);
        }

        return null;
    }

    async parseEmlxFileParts(filePath: string): Promise<MailBodyParts | null> {
        try {
            return await parseEmlxBodyPartsFromFile(filePath);
        } catch (err) {
            logger.debug(`Failed to parse emlx body parts ${filePath}: ${err}`);
            return null;
        }
    }

    /**
     * L2: Parse .emlx / .partial.emlx file directly (~42 msgs/sec with mailparser)
     */
    async parseEmlxFile(filePath: string): Promise<string | null> {
        const parts = await this.parseEmlxFileParts(filePath);
        return parts?.text || null;
    }

    /**
     * Get rich body parts for a single message. L2 emlx only; summaries are text-only.
     */
    async getBodyParts(rowid: number): Promise<MailBodyParts | null> {
        const emlxPath = this.pathIndex.get(rowid);

        if (!emlxPath) {
            const summary = this.getSummary(rowid);
            return summary ? { raw: "", html: "", markdown: summary, text: summary } : null;
        }

        const parts = await this.parseEmlxFileParts(emlxPath);

        if (parts) {
            return parts;
        }

        const summary = this.getSummary(rowid);
        return summary ? { raw: "", html: "", markdown: summary, text: summary } : null;
    }

    /**
     * Get body for a single message. L1 summaries -> L2 emlx.
     */
    async getBody(rowid: number): Promise<string | null> {
        // L1: Try summaries table first
        const summary = this.getSummary(rowid);

        if (summary) {
            return summary;
        }

        // L2: Direct emlx file reading
        const emlxPath = this.pathIndex.get(rowid);

        if (!emlxPath) {
            return null;
        }

        return this.parseEmlxFile(emlxPath);
    }

    /**
     * Get rich body parts for multiple messages.
     */
    async getBodyPartsMap(rowids: number[]): Promise<Map<number, MailBodyParts>> {
        const result = new Map<number, MailBodyParts>();

        for (const rowid of rowids) {
            const parts = await this.getBodyParts(rowid);

            if (parts) {
                result.set(rowid, parts);
            }
        }

        return result;
    }

    /**
     * Get bodies for multiple messages. Uses L1 batch + L2 for misses.
     */
    async getBodies(rowids: number[]): Promise<Map<number, string>> {
        const result = new Map<number, string>();
        const l2Needed: number[] = [];

        // L1: Batch check summaries
        for (const rowid of rowids) {
            const summary = this.getSummary(rowid);

            if (summary) {
                result.set(rowid, summary);
            } else {
                l2Needed.push(rowid);
            }
        }

        // L2: Parse emlx files for misses
        for (const rowid of l2Needed) {
            const emlxPath = this.pathIndex.get(rowid);

            if (!emlxPath) {
                continue;
            }

            const body = await this.parseEmlxFile(emlxPath);

            if (body) {
                result.set(rowid, body);
            }
        }

        return result;
    }

    dispose(): void {
        this.summaryDb?.close();
        this.summaryDb = null;
        this.summaryDbInitAttempted = false;
    }
}
