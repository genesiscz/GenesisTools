import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { resolveTranscript } from "./resolve";

function fixtureRoot(): string {
    return mkdtempSync(join(tmpdir(), "gt-transcript-"));
}

describe("resolveTranscript", () => {
    test("finds a grok native updates.jsonl by session id prefix", async () => {
        const root = fixtureRoot();
        const grokHome = join(root, "grok");
        const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001";
        const dir = join(grokHome, "sessions", encodeURIComponent("/tmp/proj"), sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "updates.jsonl"), "{}\n");

        const hit = await resolveTranscript(sessionId.slice(0, 8), {
            grokHome,
            grokWorker: join(root, "empty-worker"),
            claudeProjects: join(root, "empty-claude"),
            codexHome: join(root, "empty-codex"),
            codexWorker: join(root, "empty-codex-w"),
        });
        expect(hit.provider).toBe("grok");
        expect(hit.source).toBe("native");
        expect(hit.sessionId).toBe(sessionId);
        expect(hit.filePath).toBe(join(dir, "updates.jsonl"));
    });

    test("finds a grok worker session by name and lists turn logs", async () => {
        const root = fixtureRoot();
        const worker = join(root, "worker");
        mkdirSync(worker, { recursive: true });
        writeFileSync(
            join(worker, "demo.meta.json"),
            SafeJSON.stringify({
                name: "demo",
                sessionId: "sess-worker-1",
                cwd: "/tmp",
                workerHome: "/tmp",
                readOnly: true,
                turns: 2,
                createdAt: "2026-08-27T20:00:00.000Z",
            })
        );
        writeFileSync(join(worker, "demo.turn1.jsonl"), "{}\n");
        writeFileSync(join(worker, "demo.turn2.jsonl"), "{}\n");

        const hit = await resolveTranscript("demo", {
            grokHome: join(root, "empty-grok"),
            grokWorker: worker,
            claudeProjects: join(root, "empty-claude"),
            codexHome: join(root, "empty-codex"),
            codexWorker: join(root, "empty-codex-w"),
        });
        expect(hit.provider).toBe("grok");
        expect(hit.source).toBe("worker");
        expect(hit.filePath).toBe(join(worker, "demo.turn2.jsonl"));
        expect(hit.extraFiles).toEqual([join(worker, "demo.turn1.jsonl")]);
    });

    test("finds a codex native rollout by uuid in the filename", async () => {
        const root = fixtureRoot();
        const id = "ffffffff-1111-2222-3333-444444444444";
        const dir = join(root, "codex", "sessions", "2026", "08", "27");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `rollout-2026-08-27T20-00-00-${id}.jsonl`);
        writeFileSync(file, "{}\n");

        const hit = await resolveTranscript(id.slice(0, 8), {
            grokHome: join(root, "empty-grok"),
            grokWorker: join(root, "empty-worker"),
            claudeProjects: join(root, "empty-claude"),
            codexHome: join(root, "codex"),
            codexWorker: join(root, "empty-codex-w"),
        });
        expect(hit.provider).toBe("codex");
        expect(hit.source).toBe("native");
        expect(hit.filePath).toBe(file);
    });

    test("finds a claude jsonl under an injected projects dir", async () => {
        const root = fixtureRoot();
        const id = "12345678-aaaa-bbbb-cccc-ddddeeee0001";
        const dir = join(root, "projects", "proj");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${id}.jsonl`);
        writeFileSync(file, "{}\n");

        const hit = await resolveTranscript(id, {
            grokHome: join(root, "empty-grok"),
            grokWorker: join(root, "empty-worker"),
            claudeProjects: join(root, "projects"),
            codexHome: join(root, "empty-codex"),
            codexWorker: join(root, "empty-codex-w"),
        });
        expect(hit.provider).toBe("claude");
        expect(hit.filePath).toBe(file);
        expect(hit.sessionId).toBe(id);
    });

    test("throws when no provider has the id", async () => {
        const root = fixtureRoot();
        await expect(
            resolveTranscript("zzzzzzzz-missing", {
                grokHome: join(root, "empty-grok"),
                grokWorker: join(root, "empty-worker"),
                claudeProjects: join(root, "empty-claude"),
                codexHome: join(root, "empty-codex"),
                codexWorker: join(root, "empty-codex-w"),
            })
        ).rejects.toThrow(/No session file/);
    });
});
