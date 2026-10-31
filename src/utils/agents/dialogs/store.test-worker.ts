// One writer of a session's dialog records (the hook, the hub watcher or `claude cmux send`), for dialogs.test.ts:
// the three write one file from separate processes, and only processes can show that no record is lost.
// argv: <records root> <session id> <tool call prefix> <questions> <start at, epoch ms>
import { closeQuestion, upsertQuestion } from "./store";

const [root, sessionId, prefix, questions, startAt] = process.argv.slice(2);

if (!root || !sessionId || !prefix || !questions || !startAt) {
    throw new Error("usage: store.test-worker.ts <root> <session id> <prefix> <questions> <start at>");
}

await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));

for (let i = 0; i < Number(questions); i++) {
    const toolCallId = `${prefix}-${i}`;
    await upsertQuestion(
        {
            provider: "claude",
            sessionId,
            toolCallId,
            kind: "decision",
            question: `Question ${toolCallId}?`,
            askedAt: new Date(Number(startAt) + i).toISOString(),
            source: "hook",
        },
        root
    );

    if (i % 2 === 0) {
        await closeQuestion({ provider: "claude", sessionId, toolCallId }, new Date().toISOString(), root);
    }
}
