import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { executeBuiltin } from "./builtins";
import { saveCredential } from "./credentials";
import type { ExecutionContext } from "./types";

const ctx: ExecutionContext = { vars: {}, steps: {}, env: {} };

describe("credential persistence", () => {
    test.each(['{"token":', "null", "[]"])("preserves damaged credential bytes before saving: %s", async (damaged) => {
        const name = `fixture-${crypto.randomUUID()}`;
        const credential = { name, type: "bearer" as const, token: "fixture-token" };
        const dir = join(env.tools.getHome(), ".genesis-tools", "automate", "credentials");
        const path = join(dir, `${name}.json`);
        try {
            await saveCredential(credential);
            writeFileSync(path, damaged);
            await saveCredential({ ...credential, token: "replacement-token" });
            const copies = readdirSync(dir).filter((file) => file.startsWith(`${name}.json.corrupt-`));
            expect(copies).toHaveLength(1);
            expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(damaged);
            expect(statSync(join(dir, copies[0])).mode & 0o777).toBe(0o600);
            expect(SafeJSON.parse(readFileSync(path, "utf8")).token).toBe("replacement-token");
        } finally {
            for (const file of readdirSync(dir).filter((file) => file.startsWith(`${name}.json`))) {
                rmSync(join(dir, file));
            }
        }
    });

    test("a valid credential can be updated without making a corrupt copy", async () => {
        const name = `fixture-${crypto.randomUUID()}`;
        const dir = join(env.tools.getHome(), ".genesis-tools", "automate", "credentials");
        const path = join(dir, `${name}.json`);
        try {
            await saveCredential({ name, type: "bearer", token: "first-token" });
            await saveCredential({ name, type: "bearer", token: "second-token" });
            expect(SafeJSON.parse(readFileSync(path, "utf8")).token).toBe("second-token");
            expect(readdirSync(dir).filter((file) => file.startsWith(`${name}.json.corrupt-`))).toEqual([]);
            expect(statSync(path).mode & 0o777).toBe(0o600);
        } finally {
            rmSync(path, { force: true });
        }
    });
});

describe("handleShell timeout cleanup", () => {
    test("the spawned process is confirmed exited before the timeout error propagates", async () => {
        const marker = `automate-shell-sleep-${Date.now()}`;

        try {
            await executeBuiltin(
                {
                    id: "timeout-test",
                    name: "timeout test",
                    action: "shell",
                    params: { command: `exec -a ${marker} sleep 30`, timeout: 1 },
                },
                ctx
            );
            throw new Error("expected timeout");
        } catch (err) {
            expect(String(err)).toContain("timed out");
        }

        await new Promise((r) => setTimeout(r, 200));
        const after = Bun.spawnSync(["pgrep", "-f", marker], { env: process.env }).stdout.toString().trim();
        expect(after).toBe("");
    });
});
