import { callTo, defineRoster } from "./define";

/** C08: five callers outside src/claude read the whole session listing and filtered it themselves. */
export default defineRoster({
    name: "roster-session-listing-outside-claude",
    candidate: "C08",
    message:
        "Ask `HistoryService.catalog` with the filters you need (provider, since, limit, agents) instead of " +
        "`getSessionListing`; the catalog applies them in SQL, while a full listing scales with every transcript.",
    matcher: callTo(["getSessionListing"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/claude\//,
});
