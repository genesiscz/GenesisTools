import { describe, expect, it, mock } from "bun:test";

const dispatched: { app: string; title?: string; message: string }[] = [];
mock.module("@app/utils/notifications", () => ({
    dispatchNotification: async (e: { app: string; title?: string; message: string }) => {
        dispatched.push(e);
    },
}));

import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";
import { formatNotification, notificationSink } from "./notification";

const e: QaEntry = {
    id: "1",
    ts: 1779000000000,
    sessionId: "s",
    sessionTitle: null,
    project: "GenesisTools",
    repoRoot: "/r",
    cwd: "/r",
    branch: "feat/x",
    commitSha: "abc1234",
    isWorktree: false,
    worktreePath: null,
    aiAgent: null,
    agentLabel: null,
    tag: "question",
    question: "why X?",
    answerMd: "Because Y.",
    refs: [],
    source: "mcp",
    turnUuid: null,
};
const baseCfg: Omit<QuestionConfig, "sinks"> = { obsidianPathTemplate: "" };

describe("notificationSink", () => {
    it("off by default, on when configured", () => {
        expect(notificationSink.isEnabled({ ...baseCfg, sinks: { obsidian: true, sound: false, notify: false } })).toBe(
            false
        );
        expect(notificationSink.isEnabled({ ...baseCfg, sinks: { obsidian: true, sound: false, notify: true } })).toBe(
            true
        );
    });

    it("formats title+message and delegates to dispatchNotification with app=question", async () => {
        const f = formatNotification(e);
        expect(f.title).toContain("GenesisTools");
        expect(f.message).toContain("why X?");
        expect(f.message).toContain("Because Y.");

        await notificationSink.emit(e, { ...baseCfg, sinks: { obsidian: true, sound: false, notify: true } });
        expect(dispatched.length).toBe(1);
        expect(dispatched[0].app).toBe("question");
        expect(dispatched[0].title).toContain("GenesisTools");
        expect(dispatched[0].message).toContain("Because Y.");
    });
});
