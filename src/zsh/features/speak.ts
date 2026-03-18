import type { ZshFeature } from "./types.ts";

export const speakFeature: ZshFeature = {
    name: "speak",
    description: "Shell function: speak → tools say",
    shellScript: `
speak() { tools say "$@"; }
`.trim(),
};
