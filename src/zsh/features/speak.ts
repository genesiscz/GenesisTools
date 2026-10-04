import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { ZshFeature } from "./types.ts";

export const speakFeature: ZshFeature = {
    name: "speak",
    description: `Shell function: speak → ${toolCommand("say")}`,
    shellScript: `
speak() { ${toolCommand("say")} "$@"; }
`.trim(),
};
