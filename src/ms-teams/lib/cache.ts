import { existsSync } from "node:fs";
import { suggestCommand } from "@genesiscz/utils/cli";
import { cacheDbPath } from "./paths";
import { TeamsCache } from "./store";

export function openCache(): TeamsCache {
    const path = cacheDbPath();

    if (!existsSync(path)) {
        throw new Error(`No Teams cache yet. Run ${suggestCommand("tools ms-teams sync")} first.`);
    }

    return new TeamsCache(path);
}
