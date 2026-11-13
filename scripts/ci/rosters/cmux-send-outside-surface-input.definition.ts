import { defineRoster } from "./define";

/** C17: typing into a session's tab was written four times, each with its own escaping and Enter handling. */
export default defineRoster({
    name: "roster-cmux-send-outside-surface-input",
    candidate: "C17",
    message:
        "Type into a cmux surface through src/utils/cmux/surface-input.ts. It owns the text and key steps, the " +
        "--force flag and the order of text and Enter; a hand-built `cmux send` or `send-key` argv repeats them.",
    matcher: {
        rule: { kind: "array", has: { kind: "string", regex: "^[\"'`]send(?:-key)?[\"'`]$" } },
    },
    // The argv of a cmux call: the array's first element is the verb, and the call it is passed to names cmux.
    test: (node) =>
        /^["'`]send(?:-key)?["'`]$/.test(
            node
                .children()
                .find((child) => child.isNamed())
                ?.text() ?? ""
        ) && /cmux/i.test(node.parent()?.parent()?.field("function")?.text() ?? ""),
    onlyIn: /^src\//,
    allowedIn: /^src\/utils\/cmux\/surface-input\.ts$/,
});
