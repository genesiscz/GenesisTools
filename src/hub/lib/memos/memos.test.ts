import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actOnMemo, listMemoActions, parseSplit, scanMemos, type VoiceMemoLike } from "./index";

const memo = (id: number, title: string): VoiceMemoLike => ({
    id,
    title,
    date: new Date(Date.UTC(2026, 10, 4, 7, id)),
    path: `/memos/${id}.m4a`,
});

describe("memo to action", () => {
    it("primes on the first scan, then turns each new memo into actions and one notice", async () => {
        const statePath = join(mkdtempSync(join(tmpdir(), "memos-")), "state.json");
        const notified: string[] = [];
        const deps = {
            statePath,
            transcribe: async (entry: VoiceMemoLike) => `text of ${entry.title}`,
            split: async (text: string) => ({ todos: ["buy milk"], note: text, agentTask: "fix the checkout test" }),
            notify: async (entry: { title: string }) => {
                notified.push(entry.title);
            },
        };

        expect(await scanMemos({ ...deps, list: () => [memo(1, "old")] })).toEqual([]);
        const fresh = await scanMemos({ ...deps, list: () => [memo(1, "old"), memo(2, "Errands")] });

        expect(fresh.map((entry) => entry.title)).toEqual(["Errands"]);
        expect(notified).toEqual(["Errands"]);
        expect(listMemoActions({ statePath }).memos[0]).toMatchObject({ todos: ["buy milk"], note: "text of Errands" });
        expect(await scanMemos({ ...deps, list: () => [memo(1, "old"), memo(2, "Errands")] })).toEqual([]);
    });

    it("runs each action once, and needs a session for the agent task", async () => {
        const statePath = join(mkdtempSync(join(tmpdir(), "memos-")), "state.json");
        await scanMemos({ statePath, list: () => [] });
        await scanMemos({
            statePath,
            list: () => [memo(3, "Ideas")],
            transcribe: async () => "t",
            split: async () => ({ todos: ["a", "b"], note: "n", agentTask: "do x" }),
            notify: async () => undefined,
        });
        const [stored] = listMemoActions({ statePath }).memos;
        const todos: string[] = [];
        const sent: Array<[string, string]> = [];
        const deps = {
            statePath,
            addTodo: async (title: string) => {
                todos.push(title);
            },
            sendToSession: async (key: string, text: string) => {
                sent.push([key, text]);
                return { ok: true, detail: "delivered via cmux: typed" };
            },
        };

        expect((await actOnMemo({ id: stored.id, action: "reminders" }, deps)).detail).toBe("Added 2 reminders.");
        expect((await actOnMemo({ id: stored.id, action: "reminders" }, deps)).detail).toContain("Already done");
        expect((await actOnMemo({ id: stored.id, action: "agent" }, deps)).ok).toBe(false);
        expect((await actOnMemo({ id: stored.id, action: "agent", sessionKey: "claude:s1" }, deps)).ok).toBe(true);
        expect(todos).toEqual(["a", "b"]);
        expect(sent).toEqual([["claude:s1", "do x"]]);
    });

    it("keeps the memo as one note when the split is not JSON", () => {
        expect(parseSplit("sorry", "the memo")).toEqual({ todos: [], note: "the memo", agentTask: null });
        expect(parseSplit('```json\n{"todos":["x"],"note":"n","agentTask":null}\n```', "m")).toEqual({
            todos: ["x"],
            note: "n",
            agentTask: null,
        });
    });
});
