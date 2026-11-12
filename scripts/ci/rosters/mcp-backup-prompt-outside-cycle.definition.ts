import { defineRoster } from "./define";

/** C37: five providers showed the diff and asked for confirmation themselves before writing their config. */
export default defineRoster({
    name: "roster-mcp-backup-prompt-outside-cycle",
    candidate: "C37",
    message:
        "Show the diff and ask for confirmation through the base's `writeCycle` in " +
        "src/mcp-manager/utils/providers/types.ts, which also backs up and writes; a provider that calls " +
        "`backupManager.showDiff` / `askConfirmation` itself starts its own write cycle again.",
    matcher: {
        rule: {
            kind: "call_expression",
            has: { field: "function", regex: "backupManager\\.(?:showDiff|askConfirmation)$" },
        },
    },
    onlyIn: /^src\/mcp-manager\//,
    allowedIn: /^src\/mcp-manager\/utils\/providers\/types\.ts$/,
});
