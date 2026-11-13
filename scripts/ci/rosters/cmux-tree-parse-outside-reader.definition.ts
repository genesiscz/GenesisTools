import { callTo, defineRoster } from "./define";

/** C13: callers parsed the cmux tree output themselves after their own unbounded read. */
export default defineRoster({
    name: "roster-cmux-tree-parse-outside-reader",
    candidate: "C13",
    message:
        "Get the parsed cmux tree from src/utils/cmux/tree-read.ts (bounded, one read in flight, cached). Calling " +
        "`parseCmuxTree` yourself means you read the tree yourself too.",
    matcher: callTo(["parseCmuxTree"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/utils\/cmux\/(?:tree-read|live-layout)\.ts$/,
});
