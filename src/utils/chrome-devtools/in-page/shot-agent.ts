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
export function resolveShotLocators(arg: {
    locators: Locator[];
    testIdAttribute: string;
    /** Clicks, or scrolls into view, the first element each locator found (a step), before measuring. */
    act?: "click" | "scroll";
}): WireResolution[] {
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
        // A chain step after a shadow host searches inside it: the host's own root is not among its descendants.
        if (scope instanceof Element && scope.shadowRoot) {
            roots.push(scope.shadowRoot);
        }

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

        if (arg.act) {
            const target = elements[0];
            target.scrollIntoView({ block: "center", inline: "nearest" });
            if (arg.act === "click" && target instanceof HTMLElement) {
                target.click();
            }
        }

        // `visibility: hidden` (also inherited from an ancestor) keeps a full rectangle, so geometry alone would box
        // nothing anyone can see; such matches neither succeed alone nor widen the union.
        const visible = unique(elements).filter((element) => getComputedStyle(element).visibility === "visible");
        const rects = visible
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
            count: rects.length,
            box: { x: left + scrollX, y: top + scrollY, w: right - left, h: bottom - top },
        };
    });
}

export interface ShotPageMetrics {
    scrollX: number;
    scrollY: number;
    viewport: { w: number; h: number };
    document: { w: number; h: number };
    dpr: number;
    /** The body's font family: the labels are drawn in it. */
    font: string;
}

export function readShotPageMetrics(): ShotPageMetrics {
    const root = document.documentElement;
    return {
        scrollX,
        scrollY,
        viewport: { w: root.clientWidth, h: root.clientHeight },
        document: { w: root.scrollWidth, h: root.scrollHeight },
        dpr: devicePixelRatio,
        font: getComputedStyle(document.body ?? root).fontFamily,
    };
}

export interface ShotChipStyle {
    bg: string;
    fg: string;
    fontSize: number;
}

/** The CSS of one label chip; measure and paint must agree, so both build it from this one rule. */
export interface ShotChipSpec {
    text: string;
    style: ShotChipStyle;
}

/** Each chip's size in the page's font, measured off screen. */
export function measureShotChips(arg: { chips: ShotChipSpec[]; font: string }): Array<{ w: number; h: number }> {
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
    document.documentElement.appendChild(holder);
    try {
        return arg.chips.map((chip) => {
            const element = document.createElement("div");
            const size = chip.style.fontSize;
            element.textContent = chip.text;
            element.style.cssText = `position:absolute;white-space:pre;font:700 ${size}px/1.3 ${arg.font};padding:${Math.round(size / 7)}px ${Math.round((size * 3) / 7)}px;border-radius:3px`;
            holder.appendChild(element);
            return { w: Math.ceil(element.offsetWidth), h: Math.ceil(element.offsetHeight) };
        });
    } finally {
        holder.remove();
    }
}

export interface ShotFramePaint {
    shape: "rect" | "ellipse";
    /** The outer box, document pixels; the stroke lies inside it. */
    box: DocBox;
    stroke: string;
    strokeWidth: number;
    dash: number[];
    radius: number;
    fill: string;
}

export interface ShotChipPaint extends ShotChipSpec {
    at: { x: number; y: number };
}

export interface ShotLeaderPaint {
    from: { x: number; y: number };
    to: { x: number; y: number };
    color: string;
}

/**
 * Draws the overlay into the page, in document coordinates, above everything: frames and leader lines as one SVG,
 * label chips as HTML in the page's font. Returns the family the chips really use.
 */
export function paintShotOverlay(arg: {
    overlayId: string;
    font: string;
    frames: ShotFramePaint[];
    chips: ShotChipPaint[];
    leaders: ShotLeaderPaint[];
}): { font: string } {
    document.getElementById(arg.overlayId)?.remove();
    const root = document.createElement("div");
    root.id = arg.overlayId;
    root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    const docW = document.documentElement.scrollWidth;
    const docH = document.documentElement.scrollHeight;
    svg.setAttribute("width", String(docW));
    svg.setAttribute("height", String(docH));
    svg.setAttribute("style", "position:absolute;left:0;top:0;overflow:visible");
    root.appendChild(svg);
    // attached first: a detached element has no computed style, so the font read below would be empty
    document.documentElement.appendChild(root);

    for (const frame of arg.frames) {
        const inset = frame.strokeWidth / 2;
        const shape = document.createElementNS(svgNs, frame.shape === "ellipse" ? "ellipse" : "rect");
        if (frame.shape === "ellipse") {
            shape.setAttribute("cx", String(frame.box.x + frame.box.w / 2));
            shape.setAttribute("cy", String(frame.box.y + frame.box.h / 2));
            shape.setAttribute("rx", String(Math.max(0, frame.box.w / 2 - inset)));
            shape.setAttribute("ry", String(Math.max(0, frame.box.h / 2 - inset)));
        } else {
            shape.setAttribute("x", String(frame.box.x + inset));
            shape.setAttribute("y", String(frame.box.y + inset));
            shape.setAttribute("width", String(Math.max(0, frame.box.w - frame.strokeWidth)));
            shape.setAttribute("height", String(Math.max(0, frame.box.h - frame.strokeWidth)));
            shape.setAttribute("rx", String(frame.radius));
        }

        shape.setAttribute("fill", frame.fill || "none");
        shape.setAttribute("stroke", frame.strokeWidth > 0 ? frame.stroke : "none");
        shape.setAttribute("stroke-width", String(frame.strokeWidth));
        if (frame.dash.length > 0) {
            shape.setAttribute("stroke-dasharray", frame.dash.join(" "));
        }

        svg.appendChild(shape);
    }

    for (const leader of arg.leaders) {
        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", String(leader.from.x));
        line.setAttribute("y1", String(leader.from.y));
        line.setAttribute("x2", String(leader.to.x));
        line.setAttribute("y2", String(leader.to.y));
        line.setAttribute("stroke", leader.color);
        line.setAttribute("stroke-width", "2");
        svg.appendChild(line);
    }

    let used = arg.font;
    for (const chip of arg.chips) {
        const element = document.createElement("div");
        const size = chip.style.fontSize;
        element.textContent = chip.text;
        element.style.cssText = `position:absolute;left:${chip.at.x}px;top:${chip.at.y}px;white-space:pre;background:${chip.style.bg};color:${chip.style.fg};font:700 ${size}px/1.3 ${arg.font};padding:${Math.round(size / 7)}px ${Math.round((size * 3) / 7)}px;border-radius:3px`;
        root.appendChild(element);
        used = getComputedStyle(element).fontFamily;
    }

    return { font: used };
}

/** No animations, transitions or caret, so two screenshots a moment apart show the same page. */
export function freezeShotPage(arg: { styleId: string }): void {
    if (document.getElementById(arg.styleId)) {
        return;
    }

    const style = document.createElement("style");
    style.id = arg.styleId;
    style.textContent =
        "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
    document.documentElement.appendChild(style);
}

export function clearShotOverlay(arg: { overlayId: string; styleId?: string }): void {
    document.getElementById(arg.overlayId)?.remove();
    if (arg.styleId) {
        document.getElementById(arg.styleId)?.remove();
    }
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
