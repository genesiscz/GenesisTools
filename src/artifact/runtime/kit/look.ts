import { createContext, useContext } from "react";

/**
 * The page's type scale. "dense" is the dashboard default. "document" is the
 * design-document scale: display headings, 16 px body text, secondary prose in
 * `--text-2`, roomier cards. `Page look` sets it; the kit components read it,
 * so one prop restyles a whole page and no component grows a size prop.
 */
export type PageLook = "dense" | "document";

export const PageLookContext = createContext<PageLook>("dense");

/** The look of the enclosing Page ("dense" outside any Page). */
export function usePageLook(): PageLook {
    return useContext(PageLookContext);
}

/** The Page's content width utility, so a full-bleed bar (TopNav) can line its row up with the content. */
export const PageWidthContext = createContext("max-w-6xl");

/** Named categorical hues as CSS colours (light and dark pairs from the shared tokens; a template may retint them). */
export const HUE = {
    sky: "var(--hue-sky)",
    teal: "var(--hue-teal)",
    lime: "var(--hue-lime)",
    amber: "var(--hue-amber)",
    rose: "var(--hue-rose)",
    slate: "var(--hue-slate)",
    violet: "var(--hue-violet)",
} as const;

export type HueName = keyof typeof HUE;
