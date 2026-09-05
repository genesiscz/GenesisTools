import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/** Where `tools claude worker` keeps `<name>.meta.json` and `<name>.turn<N>.jsonl`. */
export function workersDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "claude", "workers");
}
