// One hook process bumping a per-session counter, for hooks.test.ts: concurrent PreToolUse hooks of one session run
// in separate processes, and only processes can show that no bump is lost.
// argv: <session id> <rule id> <bumps> <start at, epoch ms>
import { bumpContextCounts } from "./state";

const [sessionId, ruleId, bumps, startAt] = process.argv.slice(2);

if (!sessionId || !ruleId || !bumps || !startAt) {
    throw new Error("usage: state.test-worker.ts <session id> <rule id> <bumps> <start at>");
}

// Every worker starts at the same moment: process starts are spread over hundreds of milliseconds.
await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

for (let i = 0; i < Number(bumps); i++) {
    await bumpContextCounts(sessionId, [ruleId]);
}
