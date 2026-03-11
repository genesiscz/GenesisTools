import type { ZshFeature } from "./types.ts";

export const portFeature: ZshFeature = {
    name: "port",
    description: "Shell alias: port → tools port",
    shellScript: `port() { tools port "$@"; }`,
};
