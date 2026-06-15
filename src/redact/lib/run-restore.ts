import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { readInput, writeOutput } from "./io";
import { restore } from "./restore";
import { loadLatestSession, loadMapFile } from "./session";
import type { Mapping } from "./types";

export interface RunRestoreArgs {
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

export async function runRestore(args: RunRestoreArgs): Promise<void> {
    const mapping = await resolveMapping(args.map);
    if (mapping === null) {
        out.log.error("No mapping found: pass --map <file> or run `tools redact` first.");
        process.exitCode = 1;
        return;
    }

    const wantsClipboardInput = Boolean(args.clipboard) && !args.in;
    if (!args.in && !wantsClipboardInput && isInteractive()) {
        out.log.error("No input: pass --in <file>, --clipboard, or pipe text on stdin.");
        out.printlnErr(suggestCommand("tools redact restore", { add: ["--in", "<file>"] }));
        process.exitCode = 1;
        return;
    }

    const text = await readInput({ inFile: args.in, clipboard: wantsClipboardInput });
    const restored = restore(text, mapping);

    if (args.json) {
        out.result({ restored });
        return;
    }

    const dest = await writeOutput({
        outFile: args.out,
        clipboard: Boolean(args.clipboard) && !args.out,
        text: restored,
    });
    if (dest === "stdout") {
        out.print(restored);
    } else {
        out.log.success(`restored text written to ${dest}`);
    }
}
