import { JSDOM } from "jsdom";

export function cleanHtml(doc: Document): Element {
    const body = doc.body.cloneNode(true) as Element;

    // Remove noise elements
    const removeSelectors = [
        "script",
        "style",
        "noscript",
        "iframe",
        "nav",
        "footer",
        "header",
        "aside",
        '[class*="ad-"]',
        '[class*="ads-"]',
        '[class*="advertisement"]',
        '[class*="tracking"]',
        '[class*="cookie"]',
        '[class*="popup"]',
        '[class*="sidebar"]',
        '[class*="related"]',
        '[class*="comment"]',
        "[hidden]",
        '[aria-hidden="true"]',
    ];

    for (const sel of removeSelectors) {
        try {
            body.querySelectorAll(sel).forEach((el) => el.remove());
        } catch {
            // Invalid selector, skip
        }
    }

    // Remove empty elements
    body.querySelectorAll("div, span, p").forEach((el) => {
        if (!el.textContent?.trim() && !el.querySelector("img, video, audio")) {
            el.remove();
        }
    });

    return body;
}

export function absolutizeUrls(html: string, baseUrl: string): string {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    doc.querySelectorAll("a[href]").forEach((a) => {
        try {
            const href = a.getAttribute("href");
            if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
                a.setAttribute("href", new URL(href, baseUrl).href);
            }
        } catch {
            // Invalid URL, skip
        }
    });

    doc.querySelectorAll("img[src]").forEach((img) => {
        try {
            const src = img.getAttribute("src");
            if (src) {
                img.setAttribute("src", new URL(src, baseUrl).href);
            }
        } catch {
            // Invalid URL, skip
        }
    });

    return doc.body.innerHTML;
}
