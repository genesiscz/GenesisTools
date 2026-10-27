import { join } from "node:path";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** The decision log and its event log; a module of its own so a reader of the paths loads nothing else. */
export function decisionFiles(root = genesisToolsDir("question", "decisions")): {
    file: string;
    events: string;
} {
    return { file: join(root, "decisions.jsonl"), events: join(root, "events.jsonl") };
}
