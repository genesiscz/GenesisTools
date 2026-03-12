import type { ZshFeature } from "./types.ts";

export const portFeature: ZshFeature = {
    name: "port",
    description: "Shell alias: port → tools port",
    shellScript: `
if ! command -v port >/dev/null 2>&1 || [[ "$(command -v port)" == *"/tools"* ]]; then
    port() { tools port "$@"; }
fi
`.trim(),
};