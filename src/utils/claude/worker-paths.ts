import { genesisToolsDir } from "@genesiscz/utils/storage/root";
/** Where `tools claude worker` keeps `<name>.meta.json` and `<name>.turn<N>.jsonl`. */
export function workersDir(): string {
    return genesisToolsDir("claude", "workers");
}
