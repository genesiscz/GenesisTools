import { toolOutputPatch } from "./patches/tool-output";
import type { DesktopPatch } from "./types";

export const desktopPatches: readonly DesktopPatch[] = [toolOutputPatch];

export function desktopPatch(id: string): DesktopPatch {
    const found = desktopPatches.find((patch) => patch.id === id);
    if (!found) {
        const known = desktopPatches.map((patch) => patch.id).join(", ");
        throw new Error(`Unknown desktop patch "${id}". Known: ${known}`);
    }

    return found;
}
