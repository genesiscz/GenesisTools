import { callTo, defineRoster } from "./define";

/** C37: each mcp-manager provider wrote its harness config itself, with or without a diff, backup and confirm. */
export default defineRoster({
    name: "roster-mcp-provider-write-outside-cycle",
    candidate: "C37",
    message:
        "A provider writes its harness config through the base's `writeCycle` in " +
        "src/mcp-manager/utils/providers/types.ts (read, change, serialize, diff, confirm, backup, write). A direct " +
        "write skips the diff and the backup.",
    matcher: callTo(["writeFileSync", "writeFile", "atomicWriteFileSync", "write"]),
    test: (node) => !/^process\.std(?:out|err)\./.test(node.field("function")?.text() ?? ""),
    onlyIn: /^src\/mcp-manager\/utils\/providers\//,
    allowedIn: /^src\/mcp-manager\/utils\/providers\/types\.ts$/,
});
