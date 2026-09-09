import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { buildNativeRunArgs } from "../lib/run-options";
import { registerRunCommand } from "./run";

async function parse(argv: string[]) {
    const program = new Command().exitOverride().configureOutput({ writeErr() {} });
    registerRunCommand(program);
    const command = program.commands.find((entry) => entry.name() === "run")!;
    let result: { account: string; args: string[]; options: Record<string, string | boolean> } | undefined;
    command.action((account: string, args: string[], options: Record<string, string | boolean>) => {
        result = { account, args, options };
    });
    await program.parseAsync(argv, { from: "user" });
    return result;
}

describe("Codex native run options", () => {
    test.each([
        { argv: ["work", "--model", "astra"], model: "astra", resume: undefined },
        { argv: ["work", "--model", "terra", "--resume"], model: "terra", resume: true },
        { argv: ["work", "--model", "luna", "--resume", "invoice parser"], model: "luna", resume: "invoice parser" },
        { argv: ["work", "--resume", "invoice parser", "--model", "sol"], model: "sol", resume: "invoice parser" },
        { argv: ["--model=sol", "work", "--resume=invoice parser"], model: "sol", resume: "invoice parser" },
    ])("parses wrapper flags in $argv without turning them into a prompt", async ({ argv, model, resume }) => {
        const result = await parse(["run", ...argv]);
        expect(result?.account).toBe("work");
        expect(result?.args).toEqual([]);
        expect(result?.options.model).toBe(model);
        expect(result?.options.resume).toBe(resume);
    });

    test("preserves native arguments behind the separator", async () => {
        const result = await parse(["run", "work", "--", "resume", "native-id", "--model", "native-model"]);
        expect(result?.args).toEqual(["resume", "native-id", "--model", "native-model"]);
        expect(result?.options.model).toBeUndefined();
    });

    test("passes unknown native options faithfully", async () => {
        const result = await parse(["run", "work", "--sandbox", "workspace-write", "a prompt"]);
        expect(result?.args).toEqual(["--sandbox", "workspace-write", "a prompt"]);
    });
});

describe("native argv construction", () => {
    test("model and bare resume stay native options", () => {
        expect(buildNativeRunArgs({ args: [], options: { model: "gpt-5.6-terra", resume: true } })).toEqual([
            "--model",
            "gpt-5.6-terra",
            "resume",
        ]);
    });
    test("query resume uses the selected native ID", () => {
        expect(
            buildNativeRunArgs({
                args: [],
                options: { model: "gpt-5.6-luna", resume: "invoice parser" },
                sessionId: "session-a",
            })
        ).toEqual(["--model", "gpt-5.6-luna", "resume", "session-a"]);
    });
    test("unresolved query never becomes a native session ID", () => {
        expect(() => buildNativeRunArgs({ args: [], options: { resume: "invoice parser" } })).toThrow("resolved");
    });
    test("rejects competing native and wrapper options", () => {
        expect(() => buildNativeRunArgs({ args: ["resume", "old-id"], options: { resume: true } })).toThrow("resume");
        expect(() => buildNativeRunArgs({ args: ["--model=other"], options: { model: "gpt-6-astra" } })).toThrow(
            "model"
        );
    });
});

test("rejects repeated model and resume wrapper flags", async () => {
    await expect(parse(["run", "work", "--model", "astra", "--model", "sol"])).rejects.toThrow("model");
    await expect(parse(["run", "work", "--resume", "--resume"])).rejects.toThrow("resume");
});
test("an empty --resume still resumes the session it resolved", () => {
    // `--resume ""` used to fall through the falsy check and silently start a new thread
    // even though a session had already been picked.
    expect(buildNativeRunArgs({ args: [], options: { resume: "" }, sessionId: "01ABC" })).toEqual(["resume", "01ABC"]);
    expect(buildNativeRunArgs({ args: [], options: { resume: true }, sessionId: undefined })).toEqual(["resume"]);
    expect(buildNativeRunArgs({ args: ["prompt"], options: {}, sessionId: undefined })).toEqual(["prompt"]);
});
