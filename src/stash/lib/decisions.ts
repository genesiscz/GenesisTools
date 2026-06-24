import { readFile, writeFile } from "node:fs/promises";
import { parseMarkers } from "./markers";
import type { Decision } from "./unapply-session";

export async function applyDecisionToCode(args: {
    filePath: string;
    regionName: string;
    decision: Exclude<Decision, null>;
}): Promise<void> {
    if (args.decision === "skip") {
        return;
    }
    const content = await readFile(args.filePath, "utf8");
    const markers = parseMarkers(content);
    const m = markers.find((x) => x.name === args.regionName);
    if (!m) {
        return;
    }
    const lines = content.split("\n");
    const before = lines.slice(0, m.startLine - 1);
    const after = lines.slice(m.endLine);
    await writeFile(args.filePath, [...before, ...after].join("\n"));
}
