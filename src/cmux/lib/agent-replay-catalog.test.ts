import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyDatabasePath } from "@genesiscz/utils/agent-sessions/database";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { loadCodexCatalog, loadGrokCatalog } from "./agent-replay";

const SESSION = "11111111-2222-4333-8444-555555555555";
const CWD = "/projects/catalog-fixture";

test("cmux catalog reads Codex native titles through automatic shared metadata refresh", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-codex-catalog-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    writeFileSync(
        join(root, `rollout-${SESSION}.jsonl`),
        `${SafeJSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: CWD } })}\n`
    );
    const index = join(home, "session_index.jsonl");
    writeFileSync(index, `${SafeJSON.stringify({ id: SESSION, thread_name: "Native title" })}\n`);

    expect(await loadCodexCatalog([CWD], [root])).toMatchObject([{ sessionId: SESSION, title: "Native title" }]);
    writeFileSync(index, `${SafeJSON.stringify({ id: SESSION, thread_name: "Renamed title" })}\n`);
    expect(await loadCodexCatalog([CWD], [root])).toMatchObject([{ sessionId: SESSION, title: "Renamed title" }]);
    expect(await loadCodexCatalog(["/projects/unrelated"], [root])).toEqual([]);
});

test("a cached catalog read reports what is indexed without creating the shared history index", async () => {
    // `profiles restore --dry-run` and `restore-after-restart --list` reach this through
    // prepareProfileForRestore, and an inspection path must not initialize the schema or
    // synchronize sources.
    const home = mkdtempSync(join(tmpdir(), "cmux-cached-catalog-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    writeFileSync(
        join(root, `rollout-${SESSION}.jsonl`),
        `${SafeJSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: CWD } })}\n`
    );
    writeFileSync(
        join(home, "session_index.jsonl"),
        `${SafeJSON.stringify({ id: SESSION, thread_name: "Native title" })}\n`
    );

    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
        const index = historyDatabasePath();

        expect(existsSync(index)).toBe(false);
        expect(await loadCodexCatalog([CWD], [root], { cached: true })).toEqual([]);
        expect(existsSync(index)).toBe(false);

        // The control: the ordinary path still refreshes, so a real restore keeps its catalog.
        expect(await loadCodexCatalog([CWD], [root])).toMatchObject([{ sessionId: SESSION, title: "Native title" }]);
        expect(existsSync(index)).toBe(true);

        // Now that it IS indexed, the cached read reports it, still without a refresh.
        const before = statSync(index).mtimeMs;
        expect(await loadCodexCatalog([CWD], [root], { cached: true })).toMatchObject([{ sessionId: SESSION }]);
        expect(statSync(index).mtimeMs).toBe(before);
    });
});

test("cmux Grok catalog includes chat-only sessions without a summary sidecar", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmux-grok-catalog-"));
    const dir = join(root, encodeURIComponent(CWD), SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "chat_history.jsonl"),
        `${SafeJSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Restore fixture panes</user_query>" }] })}\n`
    );

    expect(await loadGrokCatalog([CWD], root)).toMatchObject([
        { kind: "grok", sessionId: SESSION, cwd: CWD, prompt: "Restore fixture panes" },
    ]);
});
