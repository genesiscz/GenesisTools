import { homedir } from "node:os";
import { copyToClipboard, readFromClipboard } from "@app/utils/clipboard";

export function resolveHomeDir(): string {
    return homedir();
}

export async function readInput({ inFile, clipboard }: { inFile?: string; clipboard?: boolean }): Promise<string> {
    if (inFile && inFile !== "-") {
        return Bun.file(inFile).text();
    }

    if (clipboard) {
        return readFromClipboard();
    }

    return Bun.stdin.text();
}

export type OutputDest = "file" | "clipboard" | "stdout";

export interface WriteOutputArgs {
    outFile?: string;
    clipboard?: boolean;
    text: string;
}

export async function writeOutput({ outFile, clipboard, text }: WriteOutputArgs): Promise<OutputDest> {
    if (outFile && outFile !== "-") {
        await Bun.write(outFile, text);
        return "file";
    }

    if (clipboard) {
        await copyToClipboard(text, { silent: true });
        return "clipboard";
    }

    return "stdout";
}
