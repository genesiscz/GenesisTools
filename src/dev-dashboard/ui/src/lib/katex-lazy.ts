import { SafeJSON } from "@genesiscz/utils/json";
import { escapeHtml } from "@genesiscz/utils/string";
import type { KatexOptions } from "katex";

/**
 * Stands in for `katex` inside marked-katex-extension in the client bundle (see the
 * `dev-dashboard-lazy-katex` plugin in vite.config.ts). The extension imports KaTeX eagerly for
 * its renderer, which put 260 KB into the QA chunk, while none of 1748 QA texts measured on
 * 2026-09-26 contained math. The real module now loads the first time a message has math. Until
 * it arrives the formula renders as a placeholder element, which is replaced in place once it
 * does; the server keeps rendering with the real KaTeX.
 */

type RenderToString = (tex: string, options?: KatexOptions) => string;

const TEX_ATTR = "data-dd-tex";
const OPTIONS_ATTR = "data-dd-tex-options";
const LATE_COMMIT_WINDOW_MS = 10_000;

let realRenderToString: RenderToString | null = null;
let loading = false;

function fillPlaceholders(): void {
    const render = realRenderToString;

    if (!render) {
        return;
    }

    for (const placeholder of document.querySelectorAll<HTMLElement>(`[${TEX_ATTR}]`)) {
        const tex = placeholder.getAttribute(TEX_ATTR) ?? "";
        const options = SafeJSON.parse(placeholder.getAttribute(OPTIONS_ATTR) ?? "{}", {
            strict: true,
        }) as KatexOptions;
        placeholder.outerHTML = render(tex, options);
    }
}

/**
 * A render that produced a placeholder before KaTeX arrived can commit it later: React renders a
 * long page in slices over several frames. Placeholders that land in the DOM within the window
 * are filled as they appear; after it no render can still hold one.
 */
function fillLateCommits(): void {
    const observer = new MutationObserver(fillPlaceholders);
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), LATE_COMMIT_WINDOW_MS);
}

function loadKatex(): void {
    if (loading) {
        return;
    }

    loading = true;
    import("katex")
        .then((module) => {
            realRenderToString = module.default.renderToString;
            fillPlaceholders();
            fillLateCommits();
        })
        .catch((error) => {
            loading = false;
            console.debug("katex-lazy: KaTeX failed to load", error);
        });
}

function renderToString(tex: string, options?: KatexOptions): string {
    if (realRenderToString) {
        return realRenderToString(tex, options);
    }

    loadKatex();
    const optionsJson = SafeJSON.stringify(options ?? {}, { strict: true });

    return `<span ${TEX_ATTR}="${escapeHtml(tex)}" ${OPTIONS_ATTR}="${escapeHtml(optionsJson)}">${escapeHtml(tex)}</span>`;
}

export default { renderToString };
