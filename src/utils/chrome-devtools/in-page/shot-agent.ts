/**
 * In-page half of annotated page shots. Each export is self-contained: only its source reaches the page (through
 * `callInPage`), so nothing here may reference module scope. Boxes are in document CSS pixels (viewport rect plus the
 * page scroll), so they stay valid when the page scrolls between two calls.
 */
import type { Locator, LocatorStep, TextMatch } from "../shots/locator.ts";

export interface DocBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export type WireResolution =
    | { ok: true; source: string; count: number; box: DocBox }
    | { ok: false; source: string; reason: "none" | "zero-size"; member?: string };

/**
 * Resolves each locator to the union box of what it matches. A chain that matches nothing fails its locator with
 * the chain named (`member`), and matches that are all hidden or empty fail as `zero-size`: nothing is ever boxed at
 * 0,0.
 */
export function resolveShotLocators(arg: { locators: Locator[]; testIdAttribute: string }): WireResolution[] {
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const texts = new Map<Element, string>();
    const textOf = (element: Element): string => {
        let value = texts.get(element);
        if (value === undefined) {
            value = normalize(element.textContent ?? "");
            texts.set(element, value);
        }

        return value;
    };
    const matches = (value: string, match: TextMatch): boolean => {
        switch (match.kind) {
            case "exact":
                return value === normalize(match.text);
            case "contains":
                return value.toLowerCase().includes(normalize(match.text).toLowerCase());
            case "prefix":
                return value.startsWith(match.text);
            case "regex":
                return new RegExp(match.source, match.flags).test(value);
        }
    };
    /** Every element under `scope`, through open shadow roots, in tree order. */
    const descendants = (scope: Element | Document): Element[] => {
        const found: Element[] = [];
        const walk = (root: Element | Document | ShadowRoot): void => {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (SKIP.has(element.tagName)) {
                    continue;
                }

                found.push(element);
                if (element.shadowRoot) {
                    walk(element.shadowRoot);
                }
            }
        };

        walk(scope);
        if (scope instanceof Element && scope.shadowRoot) {
            walk(scope.shadowRoot);
        }

        return found;
    };
    const cssIn = (scope: Element | Document, selector: string): Element[] => {
        const found: Element[] = [];
        const roots: Array<Element | Document | ShadowRoot> = [scope];
        for (const element of descendants(scope)) {
            if (element.shadowRoot) {
                roots.push(element.shadowRoot);
            }
        }

        for (const root of roots) {
            found.push(...Array.from(root.querySelectorAll(selector)));
        }

        return found;
    };
    const IMPLICIT: Record<string, string> = {
        BUTTON: "button",
        DIALOG: "dialog",
        H1: "heading",
        H2: "heading",
        H3: "heading",
        H4: "heading",
        H5: "heading",
        H6: "heading",
        LI: "listitem",
        UL: "list",
        OL: "list",
        NAV: "navigation",
        MAIN: "main",
        TABLE: "table",
        TR: "row",
        TD: "cell",
        TH: "columnheader",
        SELECT: "combobox",
        TEXTAREA: "textbox",
        OPTION: "option",
        FORM: "form",
    };
    const roleOf = (element: Element): string | null => {
        const explicit = element.getAttribute("role");
        if (explicit) {
            return explicit.split(/\s+/)[0];
        }

        if (element.tagName === "A") {
            return element.hasAttribute("href") ? "link" : null;
        }

        if (element.tagName === "IMG") {
            return "img";
        }

        if (element.tagName === "INPUT") {
            const type = (element.getAttribute("type") ?? "text").toLowerCase();
            if (type === "checkbox" || type === "radio") {
                return type;
            }

            return ["button", "submit", "reset", "image"].includes(type) ? "button" : "textbox";
        }

        return IMPLICIT[element.tagName] ?? null;
    };
    const byIds = (ids: string): string =>
        normalize(
            ids
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ")
        );
    const nameOf = (element: Element): string => {
        const aria = element.getAttribute("aria-label");
        if (aria) {
            return normalize(aria);
        }

        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            return byIds(labelledBy);
        }

        const labels =
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
                ? element.labels
                : null;
        if (labels && labels.length > 0) {
            return normalize(Array.from(labels, (label) => label.textContent ?? "").join(" "));
        }

        if (element.tagName === "IMG") {
            return normalize(element.getAttribute("alt") ?? "");
        }

        return textOf(element) || normalize(element.getAttribute("title") ?? "");
    };
    const search = (scope: Element | Document, step: LocatorStep): Element[] => {
        switch (step.engine) {
            case "testid":
                return cssIn(scope, `[${arg.testIdAttribute}]`).filter((element) =>
                    matches(element.getAttribute(arg.testIdAttribute) ?? "", step.match)
                );
            case "css":
                return cssIn(scope, step.selector);
            case "text": {
                const hits = descendants(scope).filter((element) => matches(textOf(element), step.match));
                // the smallest elements: drop a hit that contains another hit
                return hits.filter((element) => !hits.some((other) => other !== element && element.contains(other)));
            }
            case "role":
                return descendants(scope).filter(
                    (element) =>
                        roleOf(element) === step.role &&
                        (step.name === undefined || matches(nameOf(element), step.name))
                );
            case "label": {
                const found: Element[] = [];
                for (const element of descendants(scope)) {
                    if (
                        element instanceof HTMLLabelElement &&
                        element.control &&
                        matches(textOf(element), step.match)
                    ) {
                        found.push(element.control);
                    } else if (element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")) {
                        if (!(element instanceof HTMLLabelElement) && matches(nameOf(element), step.match)) {
                            found.push(element);
                        }
                    }
                }

                return found;
            }
            default:
                return [];
        }
    };
    const unique = (elements: Element[]): Element[] => [...new Set(elements)];
    const resolveChain = (steps: LocatorStep[]): Element[] => {
        let current: Array<Element | Document> = [document];
        for (const step of steps) {
            if (step.engine === "nth") {
                const pick = current.at(step.index);
                current = pick ? [pick] : [];
            } else if (step.engine === "has-text") {
                current = current.filter(
                    (element) => element instanceof Element && matches(textOf(element), step.match)
                );
            } else {
                current = unique(current.flatMap((scope) => search(scope, step)));
            }
        }

        return current.filter((element): element is Element => element instanceof Element);
    };

    return arg.locators.map((locator): WireResolution => {
        const elements: Element[] = [];
        for (const chain of locator.chains) {
            const found = resolveChain(chain.steps);
            if (found.length === 0) {
                return locator.chains.length > 1
                    ? { ok: false, source: locator.source, reason: "none", member: chain.source }
                    : { ok: false, source: locator.source, reason: "none" };
            }

            elements.push(...found);
        }

        const rects = unique(elements)
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length === 0) {
            return { ok: false, source: locator.source, reason: "zero-size" };
        }

        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));

        return {
            ok: true,
            source: locator.source,
            count: unique(elements).length,
            box: { x: left + scrollX, y: top + scrollY, w: right - left, h: bottom - top },
        };
    });
}

/**
 * The boxes of the page's own text inside `clip` (document pixels), one per line box: the obstacles a label must
 * not cover. Text inside the shot overlay is left out, and at most `limit` boxes come back.
 */
export function collectTextRects(arg: { clip: DocBox; limit: number; overlayId: string }): DocBox[] {
    const boxes: DocBox[] = [];
    const clip = arg.clip;
    const range = document.createRange();
    const walk = (root: Node): void => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node && boxes.length < arg.limit; node = walker.nextNode()) {
            if (node instanceof Element) {
                if (node.id === arg.overlayId) {
                    // skip the overlay's subtree: its last descendant's next node is the overlay's next sibling
                    let skip: Node | null = node;
                    while (skip.lastChild) {
                        skip = skip.lastChild;
                    }

                    walker.currentNode = skip;
                } else if (node.shadowRoot) {
                    walk(node.shadowRoot);
                }

                continue;
            }

            if (!node.textContent?.trim()) {
                continue;
            }

            range.selectNodeContents(node);
            for (const rect of Array.from(range.getClientRects())) {
                const box = { x: rect.left + scrollX, y: rect.top + scrollY, w: rect.width, h: rect.height };
                const inside =
                    box.w > 0 &&
                    box.h > 0 &&
                    box.x < clip.x + clip.w &&
                    clip.x < box.x + box.w &&
                    box.y < clip.y + clip.h &&
                    clip.y < box.y + box.h;
                if (inside) {
                    boxes.push(box);
                }
            }
        }
    };

    if (document.body) {
        walk(document.body);
    }

    return boxes;
}
