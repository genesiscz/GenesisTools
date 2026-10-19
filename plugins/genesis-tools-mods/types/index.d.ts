/** The files folded or opened against their default: `<row>|<call>|<path>`, the newest 500. */
export type FlippedFiles = string[];

declare module "claude-code" {
    interface PluginState {
        "genesis-tools-mods": { flipped: FlippedFiles };
    }
}
