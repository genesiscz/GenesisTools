import { out } from "@app/logger";
import { readInput, writeOutput } from "../io";
import { restore } from "../restore";
import { loadLatestSession, loadMapFile } from "../session";
import type { Mapping } from "../types";

export interface RestoreCmdOptions {
    in?: string;
    clipboard?: boolean;
    out?: string;
    map?: string;
    json?: boolean;
}

async function resolveMapping(mapPath: string | undefined): Promise<Mapping | null> {
    if (mapPath) {
        return loadMapFile(mapPath);
    }

    const latest = await loadLatestSession();
    return latest ? latest.mapping : null;
}

export async function runRestore(options: RestoreCmdOptions): Promise<void> {
    const mapping = await resolveMapping(options.map);
    if (mapping === null) {
        out.log.error("No mapping found: pass --map <file> or run `tools redact` first.");
        process.exitCode = 1;
        return;
    }

    const wantsClipboardInput = Boolean(options.clipboard) && !options.out;
    const text = await readInput({ inFile: options.in, clipboard: wantsClipboardInput });
    const restored = restore(text, mapping);

    if (options.json) {
        out.result({ restored });
        return;
    }

    const dest = await writeOutput({
        outFile: options.out,
        clipboard: Boolean(options.clipboard) && Boolean(options.out),
        text: restored,
    });
    if (dest === "stdout") {
        out.print(restored);
    } else {
        out.log.success(`restored text written to ${dest}`);
    }
}
