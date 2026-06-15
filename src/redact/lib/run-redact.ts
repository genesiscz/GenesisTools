import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { readInput, resolveHomeDir, writeOutput } from "./io";
import { redact } from "./redact";
import { buildSession, saveSession } from "./session";
import { ALL_TYPES, DEFAULT_TYPES, type RedactType } from "./types";

export interface RunRedactArgs {
    in?: string;
    clipboard?: boolean;
    out?: string;
    map?: string;
    types?: string;
    phones?: boolean;
    json?: boolean;
}

function parseTypes(raw: string | undefined, phones: boolean | undefined): RedactType[] {
    let types: RedactType[];
    if (raw) {
        types = (raw.split(",").map((t) => t.trim()) as RedactType[]).filter((t) => ALL_TYPES.includes(t));
    } else {
        types = [...DEFAULT_TYPES];
    }

    if (phones && !types.includes("phones")) {
        types = [...types, "phones"];
    }

    return types;
}

export async function runRedact(args: RunRedactArgs): Promise<void> {
    const wantsClipboardInput = Boolean(args.clipboard) && !args.in;
    if (!args.in && !wantsClipboardInput && isInteractive()) {
        out.log.error("No input: pass --in <file>, --clipboard, or pipe text on stdin.");
        out.printlnErr(suggestCommand("tools redact", { add: ["--in", "<file>"] }));
        process.exitCode = 1;
        return;
    }

    const text = await readInput({ inFile: args.in, clipboard: wantsClipboardInput });
    const types = parseTypes(args.types, args.phones);
    const result = redact(text, { homeDir: resolveHomeDir(), types });

    const session = buildSession({ mapping: result.mapping, now: new Date(), types });
    const sessionPath = await saveSession(session);
    if (args.map) {
        await Bun.write(args.map, SafeJSON.stringify(session, null, 2));
    }

    const uniqueCount = Object.keys(result.mapping).length;
    logger.debug(`redact: replaced ${uniqueCount} unique placeholders; session ${sessionPath}`);

    if (args.json) {
        out.result({ redacted: result.redacted, mapping: result.mapping });
    } else {
        const dest = await writeOutput({
            outFile: args.out,
            clipboard: Boolean(args.clipboard) && !args.out,
            text: result.redacted,
        });
        if (dest === "stdout") {
            out.print(result.redacted);
        } else {
            out.log.success(`redacted text written to ${dest}`);
        }
    }

    out.log.info(`replaced ${uniqueCount} unique secrets; mapping saved to ${sessionPath}`);
}
