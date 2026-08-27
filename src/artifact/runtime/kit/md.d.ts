export declare function renderMarkdown(source: string): string;
export declare function renderMarkdownInline(source: string): string;
/** Typography wrapper for rendered markdown (shared by Md, MdViewer, and kit bodies). */
export declare const MD_BODY_CLASS: string;
export interface MdProps {
    /** Markdown text to render. */
    children: string;
    className?: string;
}
/** Render a markdown string (block-level). */
export declare const Md: import("react").MemoExoticComponent<
    ({ children, className }: MdProps) => import("react/jsx-runtime").JSX.Element
>;
export interface MdViewerProps {
    /** Fetch the markdown from this URL (relative works when served). */
    src?: string;
    /** Or render this markdown string directly. */
    source?: string;
    title?: string;
    /** Show the filter box + TOC (default true). */
    chrome?: boolean;
    filterPlaceholder?: string;
}
/**
 * Markdown document viewer with a table of contents and a section filter —
 * the runtime replacement for build-time markdown inlining: point `src` at a
 * sibling .md and it stays fresh on every reload.
 */
export declare function MdViewer({
    src,
    source,
    title,
    chrome,
    filterPlaceholder,
}: MdViewerProps): import("react/jsx-runtime").JSX.Element;
