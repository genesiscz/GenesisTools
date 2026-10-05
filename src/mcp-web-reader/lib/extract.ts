import { JSDOM } from "jsdom";

export interface PageMeta {
    title?: string;
    author?: string;
    publishedTime?: string;
    url: string;
}

/** Which rule picked the content root: a `<main>`, a dominant `<article>`, the paragraph score, or the whole body. */
export type ExtractionMethod = "main" | "article" | "scored" | "body";

export interface ExtractedPage {
    /** HTML of the main content, with links and images made absolute. */
    content: string;
    meta: PageMeta;
    method: ExtractionMethod;
}

/** Elements that never carry readable content. Removed without the protection check. */
const JUNK_TAGS =
    "script, style, noscript, template, iframe, object, embed, canvas, svg, button, input, select, textarea";

/** Hidden or overlay elements. A page can mark its whole app root this way, so these are protected. */
const HIDDEN_SELECTOR =
    '[hidden], [aria-hidden="true"], dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

const NAVIGATION_SELECTOR = 'nav, [role="navigation"], [role="search"], [role="banner"], [role="contentinfo"]';

/** An element that is, or holds, the page's content never goes, whatever its class says. */
const PROTECTED_SELECTOR = 'main, [role="main"], article, h1';

/**
 * Whole words of a class or id that mark page furniture. Matched per word, so `ad-slot` is noise but
 * `download-button` and `lead-in` are not; the old `[class*="ad-"]` substring test hit both.
 */
const NOISE_WORDS = new Set([
    "ad",
    "ads",
    "adsbygoogle",
    "advert",
    "advertisement",
    "breadcrumb",
    "breadcrumbs",
    "comment",
    "comments",
    "consent",
    "cookie",
    "cookies",
    "footer",
    "gdpr",
    "modal",
    "newsletter",
    "popup",
    "promo",
    "related",
    "share",
    "sharing",
    "sidebar",
    "social",
    "sponsor",
    "sponsored",
    "subscribe",
]);

/** Blocks whose own text counts as a paragraph when scoring a container. */
const PARAGRAPH_SELECTOR = "p, pre, td, blockquote, dd";
const BLOCK_SELECTOR = "p, div, section, article, main, ul, ol, table, pre, blockquote, h1, h2, h3, h4, h5, h6";

/** A paragraph shorter than this is a caption, a label or a link list item, not prose. */
const MIN_PARAGRAPH_CHARS = 25;

/** A `<main>` or `<article>` with less readable text than this (or half the page) is a shell, not the content. */
const MIN_CONTENT_CHARS = 140;

/** A wrapper whose text is at most this much larger than the pick only adds a heading or a byline. */
const WRAPPER_GROWTH = 1.25;

/** A block with at least this many links that are nearly all of its text is a link list, not prose. */
const LINK_FARM_MIN_LINKS = 10;
const LINK_FARM_DENSITY = 0.85;

/**
 * Find the readable part of an HTML page and its metadata.
 *
 * The order: drop junk (scripts, hidden overlays), page furniture (navigation, banners, footers, link-heavy
 * asides, ad and cookie blocks), then pick the root: a `<main>` with real text, inside it an `<article>` that
 * holds most of that text, and failing both the container whose paragraphs score highest. An `<h1>` that sits
 * before the root (a title above the article) is kept.
 */
export function extractContent(html: string, url: string): ExtractedPage {
    const { document } = new JSDOM(html, { url }).window;
    const meta = readMeta(document, url);
    const body = document.body;

    if (!body) {
        return { content: "", meta, method: "body" };
    }

    removeJunk(body);
    removeCodeLabels(body);
    absolutizeUrls(body, document.baseURI);

    const { root, method } = pickRoot(body);
    removeLinkFarms(root);
    keepTitleHeading(document, root);

    return { content: root.innerHTML, meta, method };
}

function removeJunk(body: HTMLElement): void {
    for (const el of body.querySelectorAll(JUNK_TAGS)) {
        el.remove();
    }

    removeUnprotected(body.querySelectorAll(HIDDEN_SELECTOR));
    removeUnprotected(body.querySelectorAll(NAVIGATION_SELECTOR));
    removeUnprotected(body.querySelectorAll("footer"));
    removeUnprotected([...body.querySelectorAll("header")].filter((header) => !header.closest("article")));
    removeUnprotected([...body.querySelectorAll('aside, [role="complementary"]')].filter(isFurnitureAside));
    removeUnprotected(
        [...body.querySelectorAll("[class], [id]")].filter((el) => !el.closest("pre, code") && hasNoiseWord(el))
    );
}

function removeUnprotected(elements: Iterable<Element>): void {
    for (const el of elements) {
        if (!el.matches(PROTECTED_SELECTOR) && !el.querySelector(PROTECTED_SELECTOR)) {
            el.remove();
        }
    }
}

/** An aside outside the content, or one that is a menu, is furniture; a note inside an article is not. */
function isFurnitureAside(aside: Element): boolean {
    return (
        !aside.closest('main, [role="main"], article') ||
        aside.querySelector("nav") !== null ||
        linkDensity(aside) > 0.5
    );
}

function hasNoiseWord(el: Element): boolean {
    const words = `${el.getAttribute("class") ?? ""} ${el.id}`.toLowerCase().split(/[^a-z0-9]+/);
    return words.some((word) => NOISE_WORDS.has(word));
}

/**
 * A one-word label right above a code block that only repeats the block's language, such as "http" over a
 * `brush: http` block. The fence carries the language already. A heading is never a label.
 */
function removeCodeLabels(body: HTMLElement): void {
    for (const pre of body.querySelectorAll("pre")) {
        const label = pre.previousElementSibling;
        if (!label || /^H[1-6]$/.test(label.tagName)) {
            continue;
        }

        const word = normalizeSpace(label.textContent).toLowerCase();
        const hints = [pre, pre.querySelector("code")]
            .map((el) => `${el?.getAttribute("class") ?? ""} ${el?.getAttribute("data-language") ?? ""}`)
            .join(" ")
            .toLowerCase()
            .split(/[^\w+#.]+/);

        if (/^[\w+#.-]{1,20}$/.test(word) && hints.includes(word)) {
            label.remove();
        }
    }
}

function absolutizeUrls(body: HTMLElement, baseUrl: string): void {
    for (const link of body.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href") ?? "";

        if (href.startsWith("#") || /^javascript:/i.test(href)) {
            continue;
        }

        link.setAttribute("href", absoluteUrl(href, baseUrl));
    }

    for (const img of body.querySelectorAll("img")) {
        const lazy = img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src");
        const current = img.getAttribute("src");

        if (lazy && (!current || current.startsWith("data:"))) {
            img.setAttribute("src", lazy);
        }

        const src = img.getAttribute("src");

        // An inline placeholder is a few kilobytes of base64 in the markdown and shows nothing.
        if (!src || src.startsWith("data:")) {
            img.remove();
            continue;
        }

        img.setAttribute("src", absoluteUrl(src, baseUrl));
    }
}

function absoluteUrl(href: string, baseUrl: string): string {
    return URL.parse(href, baseUrl)?.href ?? href;
}

function pickRoot(body: HTMLElement): { root: Element; method: ExtractionMethod } {
    const bodyText = readableLength(body);
    const isSubstantial = (el: Element, total: number) => readableLength(el) >= Math.min(MIN_CONTENT_CHARS, total / 2);

    const main = largest(body.querySelectorAll('main, [role="main"]'));
    const scope = main && isSubstantial(main, bodyText) ? main : body;
    const scopeText = readableLength(scope);

    const articles = [...scope.querySelectorAll("article")].filter(
        (article) => !article.parentElement?.closest("article")
    );
    const article = largest(articles);

    if (article && isSubstantial(article, scopeText) && readableLength(article) >= scopeText / 2) {
        return { root: article, method: "article" };
    }

    if (scope !== body) {
        return { root: scope, method: "main" };
    }

    const scored = topScoredContainer(body);
    if (scored) {
        return { root: scored, method: "scored" };
    }

    return { root: body, method: "body" };
}

/**
 * Score containers by the paragraphs they hold, the way Readability does at its core: each paragraph of
 * real prose credits its parent fully and its grandparent by half, and a container's score shrinks with the
 * share of its text that is link text. The winner then grows through wrappers that add little text, which
 * picks up a heading or byline that sits next to the paragraphs.
 */
function topScoredContainer(body: HTMLElement): Element | null {
    const scores = new Map<Element, number>();
    const credit = (el: Element | null, score: number) => {
        if (el && body.contains(el)) {
            scores.set(el, (scores.get(el) ?? 0) + score);
        }
    };

    for (const paragraph of paragraphs(body)) {
        const text = normalizeSpace(paragraph.textContent);
        if (text.length < MIN_PARAGRAPH_CHARS) {
            continue;
        }

        const score = 1 + (text.match(/,/g)?.length ?? 0) + Math.min(3, Math.floor(text.length / 100));
        credit(paragraph.parentElement, score);
        credit(paragraph.parentElement?.parentElement ?? null, score / 2);
    }

    let best: Element | null = null;
    let bestScore = 0;

    for (const [el, score] of scores) {
        const final = score * (1 - linkDensity(el));
        if (final > bestScore) {
            best = el;
            bestScore = final;
        }
    }

    if (!best) {
        return null;
    }

    let root = best;
    while (root !== body && root.parentElement && textLength(root.parentElement) <= textLength(root) * WRAPPER_GROWTH) {
        root = root.parentElement;
    }

    return root;
}

/** Paragraph-like blocks, including a `<div>` that holds only inline content (div-soup pages). */
function paragraphs(body: HTMLElement): Element[] {
    const leafDivs = [...body.querySelectorAll("div")].filter((div) => !div.querySelector(BLOCK_SELECTOR));
    return [...body.querySelectorAll(PARAGRAPH_SELECTOR), ...leafDivs];
}

/**
 * Language pickers, category footers and navboxes sit inside the content root on wiki-style pages. A block
 * of ten or more links with almost no other text goes, unless it is most of the root (an index page).
 */
function removeLinkFarms(root: Element): void {
    const rootText = textLength(root);

    for (const block of root.querySelectorAll("ul, ol, div, section, table")) {
        if (
            block.closest("pre, code") ||
            block.matches(PROTECTED_SELECTOR) ||
            block.querySelector(PROTECTED_SELECTOR)
        ) {
            continue;
        }

        if (
            block.querySelectorAll("a").length >= LINK_FARM_MIN_LINKS &&
            linkDensity(block) >= LINK_FARM_DENSITY &&
            textLength(block) < rootText / 2
        ) {
            block.remove();
        }
    }
}

/** A title heading above an article belongs to it; carry the first one in when the root lacks its own. */
function keepTitleHeading(document: Document, root: Element): void {
    if (root.querySelector("h1")) {
        return;
    }

    const heading = document.body.querySelector("h1");
    if (heading && heading.compareDocumentPosition(root) & heading.DOCUMENT_POSITION_FOLLOWING) {
        root.prepend(heading.cloneNode(true));
    }
}

function largest(elements: Iterable<Element>): Element | null {
    let best: Element | null = null;
    let bestLength = -1;

    for (const el of elements) {
        const length = readableLength(el);
        if (length > bestLength) {
            best = el;
            bestLength = length;
        }
    }

    return best;
}

/** Text length that is not link text: menus and link lists add almost nothing to it. */
function readableLength(el: Element): number {
    return textLength(el) - linkTextLength(el);
}

function linkDensity(el: Element): number {
    const total = textLength(el);
    return total === 0 ? 0 : linkTextLength(el) / total;
}

function textLength(el: Element): number {
    return normalizeSpace(el.textContent).length;
}

function linkTextLength(el: Element): number {
    let length = 0;

    for (const link of el.querySelectorAll("a")) {
        length += textLength(link);
    }

    return length;
}

function normalizeSpace(text: string | null): string {
    return (text ?? "").replace(/\s+/g, " ").trim();
}

function readMeta(document: Document, url: string): PageMeta {
    const metaContent = (selector: string) => nonEmpty(document.querySelector(selector)?.getAttribute("content"));
    const elementText = (selector: string) =>
        nonEmpty(normalizeSpace(document.querySelector(selector)?.textContent ?? null));
    const notUrl = (value: string | undefined) => (value && !/^https?:\/\//i.test(value) ? value : undefined);

    return {
        title: metaContent('meta[property="og:title"]') ?? nonEmpty(document.title) ?? elementText("h1"),
        author:
            metaContent('meta[name="author"]') ??
            notUrl(metaContent('meta[property="article:author"]')) ??
            elementText('[rel="author"]') ??
            elementText('[itemprop="author"]'),
        publishedTime:
            metaContent('meta[property="article:published_time"]') ??
            metaContent('meta[name="publication_date"]') ??
            metaContent('meta[itemprop="datePublished"]') ??
            nonEmpty(document.querySelector("time[datetime]")?.getAttribute("datetime")),
        url,
    };
}

function nonEmpty(value: string | null | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
