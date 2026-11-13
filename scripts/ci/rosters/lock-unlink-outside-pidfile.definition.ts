import { callTo, defineRoster } from "./define";

/** C39: file-lock and the agents slot each took over a stale lock by deleting it, with no fence. */
export default defineRoster({
    name: "roster-lock-unlink-outside-pidfile",
    candidate: "C39",
    message:
        "Take over or release a lock file through src/utils/process/pidfile.ts (the fenced takeover: re-read, compare " +
        "the owner, then replace). Deleting a lock by hand lets two processes both believe they hold it.",
    matcher: callTo(["unlinkSync", "unlink", "rmSync"]),
    test: (node) => /lock/i.test(node.field("arguments")?.text() ?? ""),
    onlyIn: /^src\//,
    allowedIn: /^src\/utils\/process\/pidfile\.ts$/,
});
