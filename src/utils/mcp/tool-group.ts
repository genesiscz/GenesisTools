import type { ToolEntry } from "./tool-entry";

/** What a tool group hands an MCP server once it has loaded: its tools by wire name, and what releases them. */
export interface LoadedToolGroup {
    entries: Record<string, ToolEntry>;
    /** Releases what the group holds open (a Chrome worker, a browser tab). A group that holds nothing omits it. */
    close?: () => Promise<void>;
}

/**
 * One group of tools that a tool lends to another MCP server: the genesis-tools aggregator mounts it beside its own
 * tools, and `serveToolGroup` serves it alone. `load` is lazy, so a server that never exposes the group never imports
 * the tool behind it.
 */
export interface ToolGroupRow {
    /** Capability name, e.g. "alza". */
    id: string;
    /** Tool name prefix, e.g. "alza_". */
    prefix: string;
    /** false: mounted by default. true: mounted only when a capability list names it. */
    optIn: boolean;
    load: () => Promise<LoadedToolGroup>;
}
