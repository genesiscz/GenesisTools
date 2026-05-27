import { findTokenMatches } from "@app/utils/fuzzy-tokens";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "PRE", "CODE"]);

export function highlightMatchesInHtml(html: string, tokens: string[]): string {
    if (tokens.length === 0) {
        return html;
    }

    if (typeof window === "undefined") {
        return html;
    }

    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    walk(tpl.content, tokens);

    return tpl.innerHTML;
}

function walk(node: Node, tokens: string[]): void {
    if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;

        if (SKIP_TAGS.has(el.tagName)) {
            return;
        }
    }

    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const matches = findTokenMatches(text, tokens);

        if (matches.length === 0) {
            return;
        }

        const frag = document.createDocumentFragment();
        let cursor = 0;

        for (const m of matches) {
            if (m.start > cursor) {
                frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
            }

            const mark = document.createElement("mark");
            mark.className = "dd-qa-mark";
            mark.textContent = text.slice(m.start, m.end);
            frag.appendChild(mark);
            cursor = m.end;
        }

        if (cursor < text.length) {
            frag.appendChild(document.createTextNode(text.slice(cursor)));
        }

        node.parentNode?.replaceChild(frag, node);

        return;
    }

    for (const child of Array.from(node.childNodes)) {
        walk(child, tokens);
    }
}
