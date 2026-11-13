import { defineRoster } from "./define";

/** C35: 13 files built a CDP `Conn` themselves; `connect()` now builds it from the checked local debugger URL. */
export default defineRoster({
    name: "roster-cdp-conn-outside-connect",
    candidate: "C35",
    message:
        "Get a CDP connection from `connect(target, port)` in src/chrome-devtools/lib/cdp.ts. It builds the `Conn` " +
        "from the debugger URL rewritten to the local port and checked; a `new Conn(…)` elsewhere skips that check.",
    matcher: { rule: { kind: "new_expression", has: { field: "constructor", regex: "^Conn$" } } },
    onlyIn: /^src\//,
    allowedIn: /^src\/chrome-devtools\/lib\/cdp\.ts$/,
});
