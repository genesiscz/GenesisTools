/**
 * Parity harness: compares src/learn-from-fable/lib/transcript.ts against
 * SkillOpt's fable_clone/transcript.py on the same session files. Run whenever
 * either side changes. Python side: scripts/learn-from-fable/transcript_parity.py
 * emits the same JSON shape; diff the two outputs.
 *
 * Usage: bun scripts/learn-from-fable/transcript-parity.ts <session.jsonl...>
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { condenseForExtraction, loadTurns } from "../../src/learn-from-fable/lib/transcript";

const files = process.argv.slice(2);
if (!files.length) {
    console.error("usage: bun scripts/learn-from-fable/transcript-parity.ts <session.jsonl...>");
    process.exit(1);
}

const out: Record<string, unknown> = {};
for (const file of files) {
    // dedupeUuids off: the Python reference has no uuid dedupe; parity compares raw parsing only
    const turns = await loadTurns(file, { dedupeUuids: false });
    const windows = condenseForExtraction(turns);
    out[file.split("/").at(-1) ?? file] = {
        turns: turns.length,
        assistant: turns.filter((t) => t.role === "assistant").length,
        user: turns.filter((t) => t.role === "user").length,
        toolResult: turns.filter((t) => t.role === "tool_result").length,
        fable: turns.filter((t) => t.role === "assistant" && t.isFable).length,
        sidechain: turns.filter((t) => t.isSidechain).length,
        thinkingChars: turns.reduce((n, t) => n + t.thinking.length, 0),
        toolCalls: turns.reduce((n, t) => n + t.tools.length, 0),
        windows: windows.length,
    };
}

console.log(SafeJSON.stringify(out, null, 2));
