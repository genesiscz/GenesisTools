/**
 * Scrolls `el` into view inside its nearest scrollable ancestor WITHOUT
 * touching the window. `Element.scrollIntoView` scrolls every scrollable
 * ancestor including the document — inside the extension side panel that
 * yanks the whole YouTube page around (and with follow-mode re-firing it
 * makes the page impossible to scroll). Walks up to the first ancestor that
 * actually scrolls and adjusts only that one; when none exists (dashboard
 * pages scroll the document), falls back to plain scrollIntoView.
 */
export function scrollIntoPanelView(el: Element, opts: { behavior?: ScrollBehavior } = {}): void {
    const container = findScrollContainer(el);

    if (!container) {
        el.scrollIntoView({ block: "center", behavior: opts.behavior });
        return;
    }

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset = elRect.top - containerRect.top - (container.clientHeight - elRect.height) / 2;
    container.scrollTo({ top: container.scrollTop + offset, behavior: opts.behavior });
}

function findScrollContainer(el: Element): HTMLElement | null {
    let node = el.parentElement;

    while (node) {
        const { overflowY } = getComputedStyle(node);

        if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
            return node;
        }

        node = node.parentElement;
    }

    return null;
}
