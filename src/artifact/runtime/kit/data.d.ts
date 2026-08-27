import { type ReactNode } from "react";
import { type BodyContent, type Tone } from "./primitives";
export interface TabItem {
    id: string;
    label: string;
    content: ReactNode;
}
export interface TabsProps {
    tabs: TabItem[];
    /** Initial tab id (default: first, or the location hash). */
    initial?: string;
}
/** Tab bar + panels. The active tab syncs to the URL hash, so tabs are linkable. */
export declare function Tabs({ tabs, initial }: TabsProps): import("react/jsx-runtime").JSX.Element;
export interface TimelineEntry {
    time: string;
    title: string;
    body?: BodyContent;
    tone?: Tone;
}
export interface TimelineProps {
    entries: TimelineEntry[];
}
/** Vertical timeline with tone-colored markers. */
export declare function Timeline({ entries }: TimelineProps): import("react/jsx-runtime").JSX.Element;
export interface DataTableColumn {
    key: string;
    label: string;
    /** Right-align + monospace (numbers, ids). */
    mono?: boolean;
}
export interface DataTableProps {
    columns: DataTableColumn[];
    rows: Array<Record<string, string | number | ReactNode>>;
    /** Show a text filter box (matches any cell, string cells only). */
    filter?: boolean;
    caption?: string;
}
/** Data table with optional client-side filtering. */
export declare function DataTable({
    columns,
    rows,
    filter,
    caption,
}: DataTableProps): import("react/jsx-runtime").JSX.Element;
export interface QaItem {
    q: string;
    a: BodyContent;
    verdict?: string;
    tone?: Tone;
}
export interface QaProps {
    items: QaItem[];
    /** Open every answer initially (default: collapsed). */
    open?: boolean;
}
/** Question/answer list with optional verdict badges. */
export declare function QA({ items, open }: QaProps): import("react/jsx-runtime").JSX.Element;
