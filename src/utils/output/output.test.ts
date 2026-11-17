import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { z } from "zod";
import { defineApi, defineMethod } from "../api-descriptor";
import { toCliCommands } from "../api-descriptor/cli";
import { SafeJSON } from "../json";
import { resolveFormat, UsageError } from "./formats";
import { defineFormatter, render } from "./formatter";
import { failReply, okReply, warningDiagnostic } from "./reply";

const door = { commandOf: (call: { method: string; params: Record<string, unknown> }) => `do ${call.method}` };
const ctx = { tty: false, width: 80, door };
const rows = defineFormatter<{ id: string; n: number }[]>({
    text: (data) => data.map((r) => `${r.id} ${r.n}`),
    table: (data) => ({
        columns: [
            { key: "id", title: "Id" },
            { key: "n", title: "N" },
        ],
        rows: data.map((r) => ({ ...r })),
    }),
});

describe("render", () => {
    const reply = okReply("list", [{ id: "a", n: 1 }], {
        diagnostics: [warningDiagnostic("W", "careful")],
        next: [{ do: "go on", call: { method: "edit", params: {} } }],
    });

    test("a table gives every format; diagnostics and next actions go to stderr", () => {
        expect(render(reply, rows, "text", ctx)).toEqual({
            stdout: "a 1",
            stderr: ["warning: W: careful", "next: go on: do edit"],
        });
        expect(SafeJSON.parse(render(reply, rows, "json-compact", ctx).stdout)).toEqual({
            cols: ["id", "n"],
            rows: [["a", 1]],
        });
        expect(render(reply, rows, "toon", ctx).stdout).toContain("a,1");
        expect(render(reply, rows, "md", ctx).stdout).toContain("| Id");
        expect(SafeJSON.parse(render(reply, rows, "json", ctx).stdout)).toMatchObject({ v: 1, verb: "list", ok: true });
    });

    test("a failed reply prints nothing on stdout in text", () => {
        expect(render(failReply("x", [warningDiagnostic("E", "no")]), rows, "text", ctx)).toEqual({
            stdout: "",
            stderr: ["warning: E: no"],
        });
    });

    test("two different format flags are a usage error", () => {
        expect(resolveFormat({ toon: true })).toBe("toon");
        expect(() => resolveFormat({ md: true, json: true })).toThrow(UsageError);
    });
});

describe("toCliCommands", () => {
    test("positional words, flags from the schema, arrays split, extras apart", async () => {
        const api = defineApi({
            id: "t",
            global: "t",
            title: "t",
            summary: "t",
            methods: [
                defineMethod({
                    name: "spot",
                    params: z.object({
                        title: z.string(),
                        userSees: z.string().optional(),
                        tags: z.array(z.string()).optional(),
                        hot: z.boolean().optional(),
                        n: z.number().optional(),
                    }),
                    result: z.unknown(),
                    effect: "reversible",
                    doc: "d",
                }),
            ],
        });
        const calls: unknown[] = [];
        const program = new Command().exitOverride();
        toCliCommands(api, program, {
            positional: { spot: ["title"] },
            extra: () => [{ flags: "--json", description: "j" }],
            run: async (method, params, extra) => {
                calls.push({ method, params, extra });
            },
        });
        await program.parseAsync(
            ["spot", "hello", "--user-sees", "x", "--tags", "a,b", "--hot", "--n", "3", "--json"],
            { from: "user" }
        );
        expect(calls).toEqual([
            {
                method: "spot",
                params: { title: "hello", userSees: "x", tags: ["a", "b"], hot: true, n: 3 },
                extra: { json: true },
            },
        ]);
    });
});
