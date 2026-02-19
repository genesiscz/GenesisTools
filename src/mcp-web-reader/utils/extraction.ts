import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { cleanHtml } from "./html.js";

export interface ExtractionResult {
    content: string;
    meta: {
        title?: string;
        author?: string;
        publishedTime?: string;
        url: string;
    };
    method: "readability" | "cleaned" | "raw";
    quality: number;
}

export function extractContent(html: string, url: string): ExtractionResult {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // Try Readability extraction
    const reader = new Readability(doc.cloneNode(true) as Document);
    const article = reader.parse();

    if (article?.content) {
        const quality = calculateQuality(article.content, html);

        if (quality >= 0.3) {
            return {
                content: article.content,
                meta: {
                    title: article.title ?? undefined,
                    author: article.byline ?? undefined,
                    publishedTime: extractPublishedTime(doc),
                    url,
                },
                method: "readability",
                quality,
            };
        }
    }

    // Fallback to cleaned HTML
    const cleaned = cleanHtml(doc);
    return {
        content: cleaned.innerHTML,
        meta: {
            title: doc.title || undefined,
            url,
        },
        method: "cleaned",
        quality: 0.5,
    };
}

function calculateQuality(extracted: string, original: string): number {
    // Simple heuristic: ratio of text lengths
    const extractedText = extracted.replace(/<[^>]+>/g, "").trim();
    const originalText = original.replace(/<[^>]+>/g, "").trim();
    if (originalText.length === 0) return 0;
    return Math.min(1, extractedText.length / originalText.length);
}

function extractPublishedTime(doc: Document): string | undefined {
    const selectors = ['meta[property="article:published_time"]', 'meta[name="publication_date"]', "time[datetime]"];
    for (const sel of selectors) {
        const el = doc.querySelector(sel);
        if (el) {
            return el.getAttribute("content") || el.getAttribute("datetime") || undefined;
        }
    }
    return undefined;
}
