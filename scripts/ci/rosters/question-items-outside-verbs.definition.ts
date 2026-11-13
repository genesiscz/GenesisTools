import { callTo, defineRoster } from "./define";

/** C24: the CLI and the MCP server each split, checked and posted question items with their own steps. */
export default defineRoster({
    name: "roster-question-items-outside-verbs",
    candidate: "C24",
    message:
        "Post and poll questions through the verbs in src/question/lib/verbs.ts, which both the CLI and the MCP " +
        "server call; preparing, splitting, checking or posting items yourself skips steps one of the doors needs.",
    matcher: callTo(["postDecisionItems", "prepareQuestionItems", "splitItems", "checkDecisionItems"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/question\/lib\/(?:verbs|decisions\/items|transclude)\.ts$/,
});
