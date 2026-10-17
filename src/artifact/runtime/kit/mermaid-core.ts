/**
 * Mermaid without an install. The library is 60+ MB of node_modules (d3,
 * cytoscape, a langium parser), so it is NOT a dependency of this repo: the
 * browser loads the pinned jsdelivr ES module on first use and caches it
 * (versioned URL, immutable). First render needs the network; a single-file
 * build therefore renders its diagrams online and shows the source offline.
 * `configureMermaid({ url })` points at another copy (a vendored file, an
 * internal mirror); `configureMermaid({ load })` bypasses the URL entirely.
 *
 * Framework-free on purpose. The kit's Md/Mermaid components import it, AND
 * the markdown page chrome (page.html) inlines this very file, transpiled, so
 * a served or built .md renders its ```mermaid fences the same way. Nothing
 * here may import anything.
 */

export interface MermaidRenderResult {
    svg: string;
    /** Attaches mermaid's own interaction handlers (none under securityLevel strict). */
    bindFunctions?: (element: Element) => void;
}

export interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, text: string): Promise<MermaidRenderResult>;
}

export interface MermaidSource {
    /** ES module URL of mermaid (default: the pinned jsdelivr build). */
    url?: string;
    /** Bypass the URL entirely (tests, a bundled copy). */
    load?: () => Promise<MermaidApi>;
}

export const MERMAID_ESM_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";
/** Where the markdown renderer leaves a ```mermaid fence (`pre > code.language-mermaid`). */
export const MERMAID_FENCE_SELECTOR = "pre > code.language-mermaid";
export const MERMAID_FRAME_CLASS = "akit-mermaid";
export const MERMAID_ERROR_CLASS = "akit-mermaid-error";

let source: MermaidSource = {};
let pending: Promise<MermaidApi> | null = null;
let counter = 0;
/** The scheme mermaid was last initialized for. */
let themedFor: "light" | "dark" | null = null;
const watchedDocuments = new WeakSet<Document>();

/** Change where mermaid comes from. Resets the loaded instance, so call it before the first render. */
export function configureMermaid(next: MermaidSource): void {
    source = { ...next };
    pending = null;
}

// ─── Colour scheme ───
// These live here, not in theme.tsx, because this file must stay import-free
// (page.html inlines it) and still has to follow a scheme flip. theme.tsx and
// chartjs.tsx import them from here, so there is one copy.

/**
 * The scheme the page renders in right now. A single computed `color-scheme`
 * wins, including auto's override selectors. A dual declaration consults
 * `data-theme`, then the system preference. No declaration accepts `data-theme`
 * or falls back to dark.
 */
export function resolvedColorScheme(): "light" | "dark" {
    const root = document.documentElement;
    const declared = getComputedStyle(root).getPropertyValue("color-scheme").trim();
    const hasLight = declared.includes("light");
    const hasDark = declared.includes("dark");

    if (hasLight !== hasDark) {
        return hasLight ? "light" : "dark";
    }

    const forced = root.getAttribute("data-theme");

    if (forced === "light" || forced === "dark") {
        return forced;
    }

    if (hasLight && hasDark) {
        return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    }

    return hasLight ? "light" : "dark";
}

/** Call `listener` when the system scheme or the root's data-theme changes. Returns the unsubscribe. */
export function onColorSchemeChange(listener: () => void): () => void {
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener("change", listener);
    const observer = typeof MutationObserver === "function" ? new MutationObserver(listener) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
        media?.removeEventListener("change", listener);
        observer?.disconnect();
    };
}

/**
 * A theme token as a concrete colour. A token written with `light-dark()` or
 * `color-mix()` reads back from getPropertyValue as that unresolved text, so it
 * is resolved through a hidden probe element, which the browser computes for
 * the current scheme. Plain values (a hex colour) skip the probe.
 */
export function resolveCssColor(name: string): string {
    const root = document.documentElement;

    return resolveCssColorValue(getComputedStyle(root).getPropertyValue(name), root);
}

/** Resolve a CSS color expression in the element's inherited theme and color-scheme. */
export function resolveCssColorValue(css: string, context: Element): string {
    const raw = css.trim();

    if (!/^(light-dark|color-mix|var)\(/.test(raw)) {
        return raw;
    }

    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = raw;
    context.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();

    // A browser answers rgb(), color() or oklch(); anything else (no layout engine) keeps the raw text.
    return /^(rgb|color|oklch|oklab|#)/.test(resolved) ? resolved : raw;
}

/**
 * Theme tokens resolved to concrete colors, because mermaid computes shades
 * from them (khroma) and cannot read a `var(--ok)` string. Empty tokens are
 * dropped so mermaid falls back to its own defaults instead of parsing "".
 */
export function mermaidThemeVariables(): Record<string, string | boolean> {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string): string => resolveCssColor(name);
    const bg = token("--bg");
    const panel = token("--panel");
    const border = token("--border");
    const text = token("--text");
    const dim = token("--dim");
    const accent = token("--accent");
    const warn = token("--warn");
    const candidates: Record<string, string> = {
        fontFamily: css.getPropertyValue("--font-body").trim(),
        background: bg,
        mainBkg: panel,
        primaryColor: panel,
        primaryTextColor: text,
        primaryBorderColor: accent,
        secondaryColor: bg,
        secondaryTextColor: text,
        secondaryBorderColor: border,
        tertiaryColor: bg,
        tertiaryTextColor: text,
        tertiaryBorderColor: border,
        lineColor: dim,
        textColor: text,
        titleColor: text,
        nodeBorder: accent,
        nodeTextColor: text,
        clusterBkg: bg,
        clusterBorder: border,
        edgeLabelBackground: panel,
        actorBkg: panel,
        actorBorder: accent,
        actorTextColor: text,
        actorLineColor: border,
        signalColor: text,
        signalTextColor: text,
        labelBoxBkgColor: panel,
        labelBoxBorderColor: border,
        labelTextColor: text,
        loopTextColor: text,
        noteBkgColor: panel,
        noteBorderColor: warn,
        noteTextColor: text,
        activationBkgColor: bg,
        activationBorderColor: accent,
        sequenceNumberColor: bg,
        attributeBackgroundColorOdd: panel,
        attributeBackgroundColorEven: bg,
    };
    const variables: Record<string, string | boolean> = {
        darkMode: resolvedColorScheme() === "dark",
    };

    for (const [key, value] of Object.entries(candidates)) {
        if (value) {
            variables[key] = value;
        }
    }

    return variables;
}

export function mermaidConfig(): Record<string, unknown> {
    return {
        startOnLoad: false,
        // Labels are sanitized and click callbacks are off: the diagram source
        // is artifact content, which the renderer treats as untrusted.
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: mermaidThemeVariables(),
    };
}

/** Load (once) and initialize mermaid with the page's theme. A failed load is retried on the next call. */
export function loadMermaid(): Promise<MermaidApi> {
    if (!pending) {
        const load =
            source.load ??
            ((): Promise<MermaidApi> =>
                import(/* @vite-ignore */ source.url ?? MERMAID_ESM_URL).then(
                    (mod: { default?: MermaidApi }) => (mod.default ?? mod) as MermaidApi
                ));
        pending = load()
            .then((api) => {
                api.initialize(mermaidConfig());
                themedFor = resolvedColorScheme();

                return api;
            })
            .catch((err: unknown) => {
                pending = null;
                throw err;
            });
    }

    return pending;
}

/** Re-initialize mermaid when the page scheme changed since it was last themed, so the next render recolours. */
function retheme(api: MermaidApi): void {
    const scheme = resolvedColorScheme();

    if (scheme !== themedFor) {
        api.initialize(mermaidConfig());
        themedFor = scheme;
    }
}

/** Render one diagram to SVG markup (already sanitized by mermaid). */
export async function renderMermaidSvg(text: string): Promise<MermaidRenderResult> {
    const api = await loadMermaid();
    retheme(api);
    counter += 1;

    return api.render(`akit-mermaid-${counter}`, text);
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function markError(pre: HTMLElement, message: string): void {
    pre.dataset.mermaid = "error";
    const note = document.createElement("div");
    note.className = MERMAID_ERROR_CLASS;
    note.textContent = `mermaid: ${message}`;
    pre.before(note);
}

/**
 * Swap every ```mermaid fence under `root` for its rendered SVG. A fence that
 * fails keeps its source and gets an error line above it, so a broken diagram
 * never hides its text. Safe to call again on the same subtree: handled fences
 * are marked and skipped. Returns the number of diagrams rendered.
 */
export async function hydrateMermaidFences(root: ParentNode): Promise<number> {
    const targets: HTMLElement[] = [];

    for (const code of root.querySelectorAll<HTMLElement>(MERMAID_FENCE_SELECTOR)) {
        const pre = code.parentElement;

        if (pre && !pre.dataset.mermaid) {
            pre.dataset.mermaid = "pending";
            targets.push(pre);
        }
    }

    if (targets.length === 0) {
        return 0;
    }

    let api: MermaidApi;

    try {
        api = await loadMermaid();
    } catch (err) {
        for (const pre of targets) {
            markError(pre, `failed to load ${source.url ?? MERMAID_ESM_URL}: ${errorMessage(err)}`);
        }

        return 0;
    }

    let rendered = 0;
    retheme(api);
    watchFrames();

    for (const pre of targets) {
        try {
            counter += 1;
            const text = pre.textContent ?? "";
            const { svg, bindFunctions } = await api.render(`akit-mermaid-${counter}`, text);
            const frame = document.createElement("div");
            frame.className = MERMAID_FRAME_CLASS;
            // Kept so a colour-scheme flip can render the diagram again.
            frame.dataset.mermaidSource = text;
            frame.innerHTML = svg;
            bindFunctions?.(frame);
            pre.replaceWith(frame);
            rendered += 1;
        } catch (err) {
            markError(pre, errorMessage(err));
        }
    }

    return rendered;
}

/** Render every hydrated fence under `root` again with the current theme. Returns how many re-rendered. */
export async function rethemeMermaidFrames(root: ParentNode = document): Promise<number> {
    const frames = [...root.querySelectorAll<HTMLElement>(`.${MERMAID_FRAME_CLASS}[data-mermaid-source]`)];

    if (frames.length === 0) {
        return 0;
    }

    const api = await loadMermaid();
    retheme(api);
    let rendered = 0;

    for (const frame of frames) {
        try {
            counter += 1;
            const { svg, bindFunctions } = await api.render(
                `akit-mermaid-${counter}`,
                frame.dataset.mermaidSource ?? ""
            );
            frame.innerHTML = svg;
            bindFunctions?.(frame);
            rendered += 1;
        } catch (err) {
            frame.dataset.mermaid = "error";
            frame.title = errorMessage(err);
        }
    }

    return rendered;
}

/** One document-wide watcher: hydrated fences recolour when the scheme flips. */
function watchFrames(): void {
    if (watchedDocuments.has(document)) {
        return;
    }

    watchedDocuments.add(document);
    onColorSchemeChange(() => {
        void rethemeMermaidFrames(document);
    });
}
