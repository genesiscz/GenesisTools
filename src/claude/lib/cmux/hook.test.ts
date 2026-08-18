import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookState, installHook, parseHookPayload, removeHook } from "@app/claude/lib/cmux/hook";
import { SafeJSON } from "@genesiscz/utils/json";

describe("parseHookPayload", () => {
    test("reads a SessionStart payload", () => {
        expect(parseHookPayload('{"session_id":"abc","cwd":"/tmp","source":"startup"}')).toMatchObject({
            session_id: "abc",
            cwd: "/tmp",
        });
    });

    test("empty, non-JSON, and session-less payloads yield null instead of throwing", () => {
        expect(parseHookPayload("")).toBeNull();
        expect(parseHookPayload("   ")).toBeNull();
        expect(parseHookPayload("not json")).toBeNull();
        expect(parseHookPayload('{"cwd":"/tmp"}')).toBeNull();
    });
});

describe("hook installation", () => {
    let dir: string;
    let path: string;

    interface Settings {
        model?: string;
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>; Stop?: unknown };
    }

    const read = async (): Promise<Settings> => SafeJSON.parse(await readFile(path, "utf8")) as Settings;
    const write = async (settings: Settings) => writeFile(path, SafeJSON.stringify(settings, null, 2), "utf8");

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "claude-cmux-hook-"));
        path = join(dir, "settings.json");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("appends the hook and leaves existing entries and settings alone", async () => {
        await write({
            model: "opus",
            hooks: {
                SessionStart: [{ hooks: [{ command: "existing-hook.sh" }] }],
                Stop: [{ hooks: [{ command: "stop.sh" }] }],
            },
        });

        const result = await installHook(path);
        const settings = await read();

        expect(result.changed).toBe(true);
        expect(settings.model).toBe("opus");
        expect(settings.hooks?.Stop).toBeDefined();
        expect(settings.hooks?.SessionStart).toHaveLength(2);
        expect(settings.hooks?.SessionStart?.[0].hooks?.[0].command).toBe("existing-hook.sh");
        expect(settings.hooks?.SessionStart?.[1].hooks?.[0]).toMatchObject({
            command: "tools claude cmux record",
            timeout: 10,
        });
    });

    test("backs the file up before rewriting it", async () => {
        await write({ hooks: { SessionStart: [] } });

        const result = await installHook(path);

        expect(result.backup).toBeDefined();
        expect(await readFile(result.backup as string, "utf8")).toContain("SessionStart");
    });

    test("is idempotent — a second install changes nothing", async () => {
        await write({});
        await installHook(path);
        const after = await readFile(path, "utf8");

        const second = await installHook(path);

        expect(second.changed).toBe(false);
        expect(await readFile(path, "utf8")).toBe(after);
    });

    test("creates the hooks tree when settings.json has none", async () => {
        await write({ model: "opus" });
        await installHook(path);

        expect(await hookState(path)).toBe("installed");
    });

    test("a missing settings.json is created, not fatal", async () => {
        expect(await hookState(path)).toBe("missing");

        await installHook(path);

        expect(await hookState(path)).toBe("installed");
    });

    test("removal drops our hook and the empty entry, keeping the others", async () => {
        await write({ hooks: { SessionStart: [{ hooks: [{ command: "existing-hook.sh" }] }] } });
        await installHook(path);

        const result = await removeHook(path);
        const settings = await read();

        expect(result.changed).toBe(true);
        expect(settings.hooks?.SessionStart).toHaveLength(1);
        expect(settings.hooks?.SessionStart?.[0].hooks?.[0].command).toBe("existing-hook.sh");
        expect(await hookState(path)).toBe("missing");
    });

    test("removing a hook that is not installed is a no-op", async () => {
        await write({ hooks: { SessionStart: [{ hooks: [{ command: "existing-hook.sh" }] }] } });

        expect((await removeHook(path)).changed).toBe(false);
    });
});
