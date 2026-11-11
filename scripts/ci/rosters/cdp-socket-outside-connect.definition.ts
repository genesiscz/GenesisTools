import { defineRoster } from "./define";

/** C35: CDP sockets were opened in several places, and only some checked the debugger URL's host and port. */
export default defineRoster({
    name: "roster-cdp-socket-outside-connect",
    candidate: "C35",
    message:
        "Open a DevTools socket with `connect(target, port)` from src/chrome-devtools/lib/cdp.ts. It rewrites the " +
        "debugger URL to the local port and checks it; a `new WebSocket(…)` elsewhere skips that check.",
    matcher: { rule: { kind: "new_expression", has: { field: "constructor", regex: "^WebSocket$" } } },
    onlyIn: /^src\/(?:chrome-devtools|utils\/chrome-devtools)\//,
    allowedIn: /^src\/chrome-devtools\/lib\/cdp\.ts$/,
});
