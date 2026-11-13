import { callTo, defineRoster } from "./define";

/** C44: tools checked "is the app built, stale, does it have the part" with their own reading of appStatus. */
export default defineRoster({
    name: "roster-app-status-outside-permissions",
    candidate: "C44",
    message:
        "Ask whether a window can open through `faceReadiness` / `ensureFaceReady` in " +
        "src/macos/lib/permissions/part-readiness.ts (built, stale, part, and the fix command in one answer) instead " +
        "of reading `appStatus()` yourself.",
    matcher: callTo(["appStatus"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/macos\/lib\/permissions\//,
});
