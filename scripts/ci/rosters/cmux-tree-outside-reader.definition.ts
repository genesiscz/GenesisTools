import { defineRoster } from "./define";

/** C13: the cmux tree was read in several places, some unbounded, so one slow cmux stalled each caller differently. */
export default defineRoster({
    name: "roster-cmux-tree-outside-reader",
    candidate: "C13",
    message:
        "Read the cmux tree through src/utils/cmux/tree-read.ts. It bounds the read (deadline, one in flight, a cached " +
        "answer) and parses it once; a hand-built `cmux tree` argv brings back the unbounded reads C13 removed.",
    matcher: { rule: { kind: "array", has: { kind: "string", regex: "^[\"'`]tree[\"'`]$" } } },
    // The argv of a cmux call: the call it is passed to names cmux.
    test: (node) => /cmux/i.test(node.parent()?.parent()?.field("function")?.text() ?? ""),
    onlyIn: /^src\//,
    allowedIn: /^src\/utils\/cmux\/tree-read\.ts$/,
});
