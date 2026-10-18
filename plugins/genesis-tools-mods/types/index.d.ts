/** The files whose full diff is folded to its name: `<row>|<call>|<path>`, the newest 500. */
export type ClosedFiles = string[];

declare module "claude-code" {
    interface PluginState {
        "genesis-tools-mods": { closed: ClosedFiles };
    }
}
