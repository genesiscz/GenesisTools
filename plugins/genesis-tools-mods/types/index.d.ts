/** The files folded or opened against their default: `<row>|<call>|<path>`, the newest 500. */
export type FlippedFiles = string[];

/** The git-sync calls whose hidden diff the person opened: `<row>|<call>`, the newest 500. */
export type ShownCalls = string[];

declare module "claude-code" {
    interface PluginState {
        "genesis-tools-mods": { flipped: FlippedFiles; shown: ShownCalls };
    }
}
