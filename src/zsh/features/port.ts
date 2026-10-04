import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { ZshFeature } from "./types.ts";

export const portFeature: ZshFeature = {
    name: "port",
    description: `Shell function: port → ${toolCommand("port")}`,
    shellScript: `
if ! command -v port >/dev/null 2>&1 || [[ "$(command -v port)" == *"/tools"* ]]; then
    port() { ${toolCommand("port")} "$@"; }
fi
`.trim(),
};
