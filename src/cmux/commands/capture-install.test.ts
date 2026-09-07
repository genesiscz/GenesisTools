import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

async function rawInvoke(input: { tool: "cmux" | "zsh"; action: string; home: string; flags?: string[] }) {
    const proc = Bun.spawn(
        [
            process.execPath,
            resolve(`src/${input.tool}/index.ts`),
            input.tool === "cmux" ? "capture" : "cmux",
            input.action,
            "--home",
            input.home,
            "--no-screens",
            "--json",
            ...(input.flags ?? []),
        ],
        {
            env: { HOME: input.home, GENESIS_TOOLS_HOME: input.home, PATH: "/usr/bin:/bin" },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const [output, error, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { output, error, exitCode };
}

async function invoke(input: { tool: "cmux" | "zsh"; action: string; home: string }) {
    const { output, error, exitCode } = await rawInvoke({ ...input, flags: ["--yes"] });
    expect({ exitCode, error: exitCode === 0 ? "" : error }).toEqual({ exitCode: 0, error: "" });
    return SafeJSON.parse(output, { strict: true }) as { installed: boolean; hookPath: string; runtimePath: string };
}

test.each([
    "cmux",
    "zsh",
] as const)("%s installs the same capture feature that the other alias inspects and uninstalls", async (tool) => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-alias-"));
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "export FICTIONAL_SETTING=keep\n");
    const other = tool === "cmux" ? "zsh" : "cmux";
    const installed = await invoke({ tool, action: "install", home });
    expect(installed.installed).toBe(true);
    const status = await invoke({ tool: other, action: "status", home });
    expect(status).toMatchObject({ installed: true, hookPath: installed.hookPath, runtimePath: installed.runtimePath });
    expect((await invoke({ tool: other, action: "uninstall", home })).installed).toBe(false);
    expect(readFileSync(rc, "utf8")).toBe("export FICTIONAL_SETTING=keep\n");
});

test.each([
    "cmux",
    "zsh",
] as const)("%s refuses an unconfirmed rc edit and offers a read-only preview", async (tool) => {
    const home = mkdtempSync(join(tmpdir(), "cmux-confirm-install-"));
    const rc = join(home, ".zshrc");
    const before = "export EXAMPLE_SETTING=preserve\n";
    writeFileSync(rc, before);
    const result = await rawInvoke({ tool, action: "install", home });
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toContain("--yes");
    expect(readFileSync(rc, "utf8")).toBe(before);
    expect(existsSync(join(home, ".genesis-tools/cmux/runtime"))).toBe(false);
    const preview = await rawInvoke({ tool, action: "install", home, flags: ["--dry-run"] });
    expect(preview.exitCode).toBe(0);
    expect(readFileSync(rc, "utf8")).toBe(before);
    expect(existsSync(join(home, ".genesis-tools/cmux/runtime"))).toBe(false);
});

test("reinstall warns already installed and does not rewrite the rc", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-already-installed-"));
    await invoke({ tool: "cmux", action: "install", home });
    const rc = join(home, ".zshrc");
    const before = readFileSync(rc, "utf8");
    const result = await rawInvoke({ tool: "zsh", action: "install", home });
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("already installed");
    expect(readFileSync(rc, "utf8")).toBe(before);
});

test.each(["cmux", "zsh"] as const)("%s requires confirmation before uninstall edits the rc", async (tool) => {
    const home = mkdtempSync(join(tmpdir(), "cmux-uninstall-confirm-"));
    await invoke({ tool, action: "install", home });
    const rc = join(home, ".zshrc");
    const before = readFileSync(rc, "utf8");
    const result = await rawInvoke({ tool, action: "uninstall", home });
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toContain("--yes");
    expect(readFileSync(rc, "utf8")).toBe(before);
});
