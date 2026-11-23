import { definePatch } from "./define-patch";

export const claudeCodePatches = [
    definePatch({
        id: "version-label",
        description: "Mark patched builds in --version output",
        find: " (Claude Code)${",
        replace: " (Claude Mod) ${",
    }),
];
