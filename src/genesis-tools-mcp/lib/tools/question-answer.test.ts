import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageTitle } from "@app/question/lib/message";
import { runAsCaller } from "@genesiscz/utils/agent/runtime";
import { encodeRgbaToPng } from "@genesiscz/utils/image/raster";
import { SafeJSON } from "@genesiscz/utils/json";
import { handleInboxSend } from "./inbox-send";
import { handleQuestionAnswer, QUESTION_ANSWER_INPUT_SCHEMA } from "./question-answer";

describe("question_answer handler", () => {
    it("records and returns a structured summary with source=mcp", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-mcp-"));
        const r = await handleQuestionAnswer(
            { question: "why sqlite read-model?", answer: "fast read-after-write", tag: "question" },
            {
                logBase,
                env: { CLAUDE_CODE_SESSION_ID: "s", CLAUDECODE: "1" },
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        );
        expect(r.id).toMatch(/.+/);
        expect(r.summary).toContain(r.id);
        const f = join(logBase, readdirSync(logBase)[0]);
        const row = SafeJSON.parse(readFileSync(f, "utf8").trim()) as { source: string };
        expect(row.source).toBe("mcp");
    });
});

describe("question_answer images", () => {
    it("advertises the optional image format and returns durable paths from the handler", async () => {
        expect(QUESTION_ANSWER_INPUT_SCHEMA.properties.attachments.items.required).toEqual(["type", "path"]);
        expect(QUESTION_ANSWER_INPUT_SCHEMA.required).toEqual(["question", "answer", "tag"]);
        const root = mkdtempSync(join(tmpdir(), "qa-mcp-images-"));
        const source = join(root, "shot.png");
        writeFileSync(source, encodeRgbaToPng(new Uint8ClampedArray([30, 60, 90, 255]), 1, 1));
        const result = await handleQuestionAnswer(
            {
                question: "Is this fixed?",
                answer: "Here is the result.",
                tag: "question",
                attachments: [{ type: "image", path: source, label: "Result" }],
            },
            {
                logBase: join(root, "log"),
                attachmentsRoot: join(root, "durable"),
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        );
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0].path).toStartWith(join(root, "durable"));
        expect(result.attachments[0].path).not.toBe(source);
        expect(result.attachments[0].label).toBe("Result");
    });
});

it("accepts explicit source context when a multiplexed gateway has no thread identity", async () => {
    const logBase = mkdtempSync(join(tmpdir(), "qa-gateway-context-"));
    const receipt = await runAsCaller({ agent: "codex", sessionId: null, cwd: "/" }, () =>
        handleQuestionAnswer(
            {
                question: "Did the feature finish?",
                answer: "Here is its evidence.",
                tag: "action",
                sessionHint: "explicit-session",
                projectPath: "/fixture/source-worktree",
            },
            { logBase, env: {}, config: { sinks: { obsidian: false, sound: false, notify: false } } }
        )
    );
    expect(receipt.context).toMatchObject({
        agent: "codex",
        sessionId: "explicit-session",
        cwd: "/fixture/source-worktree",
        project: "source-worktree",
        transcriptAnchor: { kind: "receipt-time", provider: "codex", sessionId: "explicit-session" },
    });
    expect(receipt.warnings).toEqual([]);
});

it("reports unavailable gateway identity in its receipt instead of hiding it", async () => {
    const receipt = await runAsCaller({ agent: "codex", sessionId: null, cwd: "/" }, () =>
        handleQuestionAnswer(
            {
                question: "Did the feature finish?",
                answer: "Here is its evidence.",
                tag: "action",
            },
            {
                logBase: mkdtempSync(join(tmpdir(), "qa-gateway-unknown-")),
                env: {},
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        )
    );
    expect(receipt.context.sessionId).toBe("unknown");
    expect(receipt.context.transcriptAnchor?.kind).toBe("unanchored");
    expect(receipt.warnings).toHaveLength(1);
});

it("records the answer when native IDs arrive from a caller with no provider", async () => {
    const receipt = await runAsCaller({ agent: "unknown", sessionId: null, cwd: "/" }, () =>
        handleQuestionAnswer(
            {
                question: "Did the feature finish?",
                answer: "Here is its evidence.",
                tag: "action",
                sessionHint: "explicit-session",
                sourceMessage: { messageId: "native-message" },
            },
            {
                logBase: mkdtempSync(join(tmpdir(), "qa-gateway-no-provider-")),
                env: {},
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        )
    );
    expect(receipt.id).toMatch(/.+/);
    expect(receipt.context.transcriptAnchor?.kind).toBe("unanchored");
    expect(receipt.warnings).toHaveLength(1);
});

describe("inbox_send", () => {
    const quiet = { sinks: { obsidian: false, sound: false, notify: false } };

    function shot(root: string): string {
        const path = join(root, "result.png");
        writeFileSync(path, encodeRgbaToPng(new Uint8ClampedArray([30, 60, 90, 255]), 1, 1));
        return path;
    }

    function logged(logBase: string): { tag: string; question: string; answerMd: string; agent: string } {
        return SafeJSON.parse(readFileSync(join(logBase, readdirSync(logBase)[0]), "utf8").trim());
    }

    const harnesses = [
        { name: "Claude", env: { CLAUDE_CODE_SESSION_ID: "claude-session", CLAUDECODE: "1" }, agent: "claude-code" },
        { name: "Codex", env: { CODEX_CI: "1", CODEX_THREAD_ID: "codex-thread" }, agent: "codex" },
        { name: "Grok", env: { GROK_SESSION_ID: "grok-session" }, agent: "grok" },
    ] as const;

    for (const harness of harnesses) {
        it(`a ${harness.name} message carries that session and the screenshot`, async () => {
            const root = mkdtempSync(join(tmpdir(), "inbox-send-"));
            const logBase = join(root, "log");
            const receipt = await handleInboxSend(
                { text: "Build is green\nAll tests pass.", images: [shot(root)], projectPath: root },
                {
                    logBase,
                    attachmentsRoot: join(root, "durable"),
                    env: harness.env,
                    config: quiet,
                    inboxState: "running",
                }
            );
            const sessionId = Object.values(harness.env).find((value) => value !== "1");

            expect(receipt.context).toMatchObject({ agent: harness.agent, sessionId });
            expect(receipt.warnings).toEqual([]);
            expect(receipt.attachments).toHaveLength(1);
            expect(receipt.attachments[0]?.path).toStartWith(join(root, "durable"));
            expect(receipt.summary).toContain("Delivered to the user's widget inbox.");
            expect(logged(logBase)).toMatchObject({
                tag: "message",
                question: "Build is green",
                answerMd: "Build is green\nAll tests pass.",
                agent: harness.agent,
            });
        });
    }

    it("a Codex call through the gateway takes the session the gateway resolved", async () => {
        const root = mkdtempSync(join(tmpdir(), "inbox-send-gateway-"));
        const receipt = await runAsCaller({ agent: "codex", sessionId: "codex-thread", cwd: root }, () =>
            handleInboxSend(
                { text: "Done.", title: "Migration finished" },
                { logBase: join(root, "log"), env: {}, config: quiet, inboxState: "installed" }
            )
        );

        expect(receipt.context).toMatchObject({ agent: "codex", sessionId: "codex-thread" });
        expect(receipt.summary).toContain("also tell the user in this chat");
    });

    it("refuses a message with neither text nor image, and an unknown session gets the warning", async () => {
        const root = mkdtempSync(join(tmpdir(), "inbox-send-empty-"));
        const deps = { logBase: join(root, "log"), env: {}, config: quiet, inboxState: "running" as const };

        await expect(handleInboxSend({ text: "  " }, deps)).rejects.toThrow("needs text, an image, or both");
        const receipt = await runAsCaller({ agent: "unknown", sessionId: null, cwd: root }, () =>
            handleInboxSend({ text: "Heads up" }, deps)
        );
        expect(receipt.warnings[0]).toContain("tools question message");
    });

    it("question_answer takes plain image paths as well", async () => {
        const root = mkdtempSync(join(tmpdir(), "qa-images-shorthand-"));
        const result = await handleQuestionAnswer(
            { question: "Fixed?", answer: "Yes.", tag: "action", images: [shot(root)], projectPath: root },
            { logBase: join(root, "log"), attachmentsRoot: join(root, "durable"), env: {}, config: quiet }
        );

        expect(result.attachments).toHaveLength(1);
        expect(messageTitle("# Long heading\nbody")).toBe("Long heading");
        expect(messageTitle("x".repeat(200))).toHaveLength(120);
    });
});
