import { describe, expect, it, mock } from "bun:test";

const dispatched: { app: string; title?: string; message: string; open?: string }[] = [];

mock.module("@app/utils/notifications", () => ({
    dispatchNotification: async (e: { app: string; title?: string; message: string; open?: string }) => {
        dispatched.push(e);
    },
}));

mock.module("@app/dev-dashboard/lib/qa-deep-link", () => ({
    buildQaDeepLink: async (id: string) => `http://myhost.example.com/qa?id=${encodeURIComponent(id)}`,
}));

import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";
import { formatNotification, notificationSink } from "./notification";

const e: QaEntry = {
    id: "abc-entry",
    ts: 1779000000000,
    sessionId: "s",
    sessionTitle: null,
    project: "GenesisTools",
    repoRoot: "/r",
    cwd: "/r",
    branch: "feat/x",
    commitSha: "abc1234",
    commitMessage: null,
    agent: "unknown",
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

    it("formats title+message+open and delegates to dispatchNotification with app=question", async () => {
        const f = await formatNotification(e);
        expect(f.title).toContain("GenesisTools");
        expect(f.message).toContain("why X?");
        expect(f.message).toContain("Because Y.");
        expect(f.open).toBe("http://myhost.example.com/qa?id=abc-entry");

        dispatched.length = 0;
        await notificationSink.emit(e, { ...baseCfg, sinks: { obsidian: true, sound: false, notify: true } });
        expect(dispatched.length).toBe(1);
        expect(dispatched[0].app).toBe("question");
        expect(dispatched[0].title).toContain("GenesisTools");
        expect(dispatched[0].message).toContain("Because Y.");
        expect(dispatched[0].open).toBe("http://myhost.example.com/qa?id=abc-entry");
    });
});
