import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    associateCapturedSurface,
    captureJournalDirectory,
    loadCapturedCommands,
    recordCapturedCommand,
} from "@app/cmux/lib/capture-journal";
import { env } from "@genesiscz/utils/env";

const surfaceId = "11111111-1111-4111-8111-111111111111";

test("recovers exact shell syntax and launch cwd after the process has completed", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-capture-test-"));
    const command = "tools usage --name 'two words' | tail -n 4\nprintf '%s' \"$PWD\"";
    recordCapturedCommand({ directory, surfaceId, command, cwd: "/launch cwd", phase: "running", atMs: 100 });
    recordCapturedCommand({
        directory,
        surfaceId,
        command,
        cwd: "/launch cwd",
        phase: "completed",
        exitStatus: 7,
        atMs: 200,
    });
    expect(loadCapturedCommands({ directory }).get(surfaceId)).toMatchObject({
        command: "tools usage --name 'two words' | tail -n 4\nprintf '%s' \"$PWD\"",
        cwd: "/launch cwd",
        phase: "completed",
        exitStatus: 7,
    });
    expect(loadCapturedCommands({ directory, beforeMs: 150 }).get(surfaceId)?.phase).toBe("running");
    expect(loadCapturedCommands({ directory, beforeMs: 99 }).size).toBe(0);
});

test("rejects path traversal in a surface identity before writing", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-capture-invalid-"));
    expect(() =>
        recordCapturedCommand({ directory, surfaceId: "../outside", command: "pwd", cwd: "/tmp", phase: "running" })
    ).toThrow();
    expect(loadCapturedCommands({ directory }).size).toBe(0);
});

test("retains a previous generation for a cutoff when the per-surface journal rotates", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-capture-rotation-"));
    recordCapturedCommand({ directory, surfaceId, command: "tools usage", cwd: "/old", phase: "running", atMs: 1 });

    for (let index = 2; index <= 20; index++) {
        recordCapturedCommand({
            directory,
            surfaceId,
            command: "x".repeat(65536),
            cwd: "/new",
            phase: "running",
            atMs: index,
        });
    }

    expect(loadCapturedCommands({ directory, beforeMs: 1 }).get(surfaceId)?.command).toBe("tools usage");
    expect(loadCapturedCommands({ directory }).get(surfaceId)?.atMs).toBe(20);
});

test("equal timestamps preserve append order across rotation while older records cannot replace newer ones", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-capture-ties-"));

    for (let index = 0; index < 20; index++) {
        recordCapturedCommand({
            directory,
            surfaceId,
            command: "x".repeat(65536),
            cwd: "/cwd",
            phase: "running",
            atMs: 500,
        });
    }

    recordCapturedCommand({
        directory,
        surfaceId,
        command: "newest-at-same-ms",
        cwd: "/cwd",
        phase: "completed",
        exitStatus: 0,
        atMs: 500,
    });
    recordCapturedCommand({
        directory,
        surfaceId,
        command: "older-wall-clock",
        cwd: "/cwd",
        phase: "running",
        atMs: 100,
    });
    expect(loadCapturedCommands({ directory }).get(surfaceId)?.command).toBe("newest-at-same-ms");
    expect(loadCapturedCommands({ directory, beforeMs: 100 }).get(surfaceId)?.command).toBe("older-wall-clock");
});

// Regression test: pre-push no-homedir-genesis-tools — journal paths must respect the test sandbox.
test("default journal directory uses the configured GenesisTools home", async () => {
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: "/tmp/cmux-test-home" }, () => {
        expect(captureJournalDirectory()).toBe("/tmp/cmux-test-home/.genesis-tools/cmux/command-journal");
    });
});

// Regression: runtime UUIDs can change on restore while the persisted surface identity remains.
test("stable identity retains command history across runtime IDs and workspace moves", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-stable-test-"));
    const stableSurfaceId = "33333333-3333-4333-8333-333333333333";
    recordCapturedCommand({
        directory,
        surfaceId,
        stableSurfaceId,
        command: "tail -f service.log",
        cwd: "/tmp/project-a",
        phase: "running",
        atMs: 10,
    });
    recordCapturedCommand({
        directory,
        surfaceId: "22222222-2222-4222-8222-222222222222",
        stableSurfaceId,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        command: "printf moved",
        cwd: "/tmp/project-b",
        phase: "completed",
        exitStatus: 0,
        atMs: 20,
    });
    expect(loadCapturedCommands({ directory }).get(stableSurfaceId)).toMatchObject({
        command: "printf moved",
        cwd: "/tmp/project-b",
    });
    expect(loadCapturedCommands({ directory, beforeMs: 15 }).get(stableSurfaceId)).toMatchObject({
        command: "tail -f service.log",
        cwd: "/tmp/project-a",
    });
});

test("the first command is linked after native autosave eventually supplies a stable identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-late-identity-"));
    recordCapturedCommand({
        directory,
        surfaceId,
        command: "tail -f service.log",
        cwd: "/tmp/project",
        phase: "running",
        atMs: 1,
    });
    const stableSurfaceId = "55555555-5555-4555-8555-555555555555";
    associateCapturedSurface({ directory, surfaceId, stableSurfaceId });
    expect(loadCapturedCommands({ directory }).get(stableSurfaceId)?.command).toBe("tail -f service.log");
});

test("short appends are retried until a complete UTF-8 record is persisted", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-short-write-"));
    const original = fs.writeSync;
    const spy = spyOn(fs, "writeSync").mockImplementation((fd, data, offset, length) => {
        if (typeof data === "string") {
            return original(fd, data);
        }
        return original(
            fd,
            data,
            typeof offset === "number" ? offset : 0,
            Math.min(typeof length === "number" ? length : data.byteLength, 7)
        );
    });
    try {
        recordCapturedCommand({ directory, surfaceId, command: "echo café", cwd: "/tmp", phase: "completed" });
        expect(loadCapturedCommands({ directory }).get(surfaceId)?.command).toBe("echo café");
        expect(spy.mock.calls.length).toBeGreaterThan(1);
    } finally {
        spy.mockRestore();
    }
});
