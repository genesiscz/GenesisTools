import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowAgent, WorkflowRun } from "@genesiscz/utils/agent-sessions/workflow-types";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import * as workflows from "@genesiscz/utils/ai/transcripts/workflows";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { captureOutput } from "@genesiscz/utils/test/capture-out";
import { printWorkflowGrep, printWorkflowList } from "./session-workflows";

const dir = mkdtempSync(join(tmpdir(), "gt-session-workflows-"));
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

const session: ResolvedTranscript = {
    provider: "claude",
    source: "native",
    sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
    filePath: join(dir, "session.jsonl"),
};

function agent(agentId: string, transcript: string | null, revivals: string[] = []): WorkflowAgent {
    return {
        agentId,
        label: agentId,
        phase: null,
        model: null,
        state: "done",
        attempt: null,
        startedAt: null,
        transcript,
        revivals,
        bytes: 0,
        hasResult: false,
        resultBytes: 0,
        promptPreview: null,
        sources: ["disk"],
        journal: null,
        supersededBy: null,
    };
}

function run(agents: WorkflowAgent[]): WorkflowRun {
    return {
        runId: "wf_fixture-001",
        name: "fixture",
        summary: null,
        status: "completed",
        error: null,
        startedAt: "2026-11-01T10:00:00.000Z",
        durationMs: null,
        defaultModel: null,
        phases: [],
        scriptPath: null,
        recordPath: null,
        journalPath: null,
        transcriptDir: dir,
        reported: { agents: null, tokens: null, toolCalls: null },
        agents,
    };
}

function transcript(name: string, rows: Array<{ timestamp: string; text: string }>): string {
    const path = join(dir, name);
    writeFileSync(
        path,
        rows
            .map(({ timestamp, text }) =>
                SafeJSON.stringify({ type: "assistant", timestamp, message: { content: [{ type: "text", text }] } })
            )
            .join("\n")
    );
    return path;
}

test("grep prints each hit's time in local time, and names a revival's file", async () => {
    const own = transcript("agent-a1.jsonl", [{ timestamp: "2026-11-01T10:00:00.000Z", text: "needle one" }]);
    const revival = transcript("agent-a1-revival.jsonl", [
        { timestamp: "2026-11-01T11:00:00.000Z", text: "needle two" },
    ]);
    const runs = spyOn(workflows, "sessionWorkflowRuns").mockResolvedValue({
        supported: true,
        items: [run([agent("a1", own, [revival])])],
    });

    try {
        const { stdout } = await captureOutput(() => printWorkflowGrep(session, { pattern: /needle/ }));
        expect(stdout).toContain(`L1 ${formatLocalDateTimeStamp("2026-11-01T10:00:00.000Z")} [assistant]`);
        expect(stdout).toContain(`${revival} L1 ${formatLocalDateTimeStamp("2026-11-01T11:00:00.000Z")} [assistant]`);
    } finally {
        runs.mockRestore();
    }
});

test("list --usage says how many agents it could not read, beside a total that lacks them", async () => {
    const runs = spyOn(workflows, "sessionWorkflowRuns").mockResolvedValue({
        supported: true,
        items: [run([agent("a1", join(dir, "a1.jsonl")), agent("b2", join(dir, "b2.jsonl"))])],
    });
    const usage = spyOn(workflows, "workflowAgentUsage").mockImplementation(async (_provider, [file]) =>
        file?.endsWith("a1.jsonl")
            ? {
                  calls: 2,
                  input: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                  output: 5,
                  costUsd: 0.01,
                  models: ["claude-opus-4-5"],
                  firstAt: null,
                  lastAt: null,
              }
            : null
    );

    try {
        const { stdout } = await captureOutput(() => printWorkflowList(session, { usage: true }));
        expect(stdout).toContain("(+1 unread)");
        expect(stdout).toContain("1 agent transcript(s) could not be read");
    } finally {
        runs.mockRestore();
        usage.mockRestore();
    }
});
