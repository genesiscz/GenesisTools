import { expect, test } from "bun:test";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    captureInstallationStatus,
    installCapture,
    resolveCaptureBun,
    uninstallCapture,
} from "@app/cmux/lib/capture-installer";
import { loadCapturedCommands } from "@app/cmux/lib/capture-journal";

test("installation is idempotent and uninstall preserves unrelated rc bytes and journal data", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-home-"));
    const rcPath = join(home, ".zshrc");
    const original = "# keep this exactly\r\nexport EXAMPLE='two words'";
    writeFileSync(rcPath, original);
    const installed = await installCapture({ home, screens: false });
    expect(installed.installed).toBe(true);
    expect(readFileSync(installed.backupPath!, "utf8")).toBe(original);
    const firstRc = readFileSync(rcPath, "utf8");
    const again = await installCapture({ home, screens: false });
    expect(again.changed).toBe(false);
    expect(again.backupPath).toBeUndefined();
    expect(readFileSync(rcPath, "utf8")).toBe(firstRc);
    const journal = join(home, ".genesis-tools/cmux/command-journal");
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, "keep.txt"), "fixture data");
    uninstallCapture({ home });
    expect(readFileSync(rcPath, "utf8")).toBe(original);
    expect(readFileSync(join(journal, "keep.txt"), "utf8")).toBe("fixture data");
    expect(captureInstallationStatus({ home }).installed).toBe(false);
});

test("status on an unconfigured home does not create files", () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-status-"));
    expect(captureInstallationStatus({ home }).installed).toBe(false);
    expect(readdirSync(home)).toEqual([]);
});

test("installed recorder survives removal of its source checkout entrypoint and runs from tmp", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-install-relocate-"));
    const source = join(directory, "checkout");
    const home = join(directory, "home");
    const entrypoint = join(source, "src/cmux/capture-record.ts");
    cpSync(resolve("src/cmux"), join(source, "src/cmux"), { recursive: true });
    cpSync(resolve("tsconfig.json"), join(source, "tsconfig.json"));
    symlinkSync(resolve("src/utils"), join(source, "src/utils"));
    symlinkSync(resolve("node_modules"), join(source, "node_modules"));
    const result = await installCapture({ home, recorderEntrypoint: entrypoint, screens: false });
    renameSync(source, `${source}-removed`);
    expect(existsSync(entrypoint)).toBe(false);
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        cwd: "/private/tmp",
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
            HOME: home,
            GENESIS_TOOLS_HOME: home,
            PATH: "/usr/bin:/bin",
            CMUX_SURFACE_ID: "11111111-1111-4111-8111-111111111111",
        },
    });
    proc.stdin.write(`source '${result.hookPath}'\nprintf '%s' 'portable capture'\n`);
    proc.stdin.end();
    const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(code).toBe(0);
    expect(errors).not.toContain("capture failed");
    expect(output).toContain("portable capture");
    expect(
        loadCapturedCommands({ directory: join(home, ".genesis-tools/cmux/command-journal") }).get(
            "11111111-1111-4111-8111-111111111111"
        )?.command
    ).toBe("printf '%s' 'portable capture'");
});

test("legacy migration removes only our exact source line and backs up the original", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-legacy-"));
    const rcPath = join(home, ".zshrc");
    const original =
        "# source ~/.genesis-tools/cmux/capture.zsh\nsource ~/.genesis-tools/cmux/capture.zsh\nsource ~/other/capture.zsh\n";
    writeFileSync(rcPath, original);
    const installed = await installCapture({ home, screens: false });
    expect(readFileSync(installed.backupPath!, "utf8")).toBe(original);
    expect(installed.legacySource).toBe(false);
    expect((await installCapture({ home, screens: false })).changed).toBe(false);
    uninstallCapture({ home });
    expect(readFileSync(rcPath, "utf8")).toBe(
        "# source ~/.genesis-tools/cmux/capture.zsh\nsource ~/other/capture.zsh\n"
    );
});

test("malformed managed markers fail before changing shell configuration", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-malformed-"));
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "# >>> GenesisTools cmux capture >>>\nuser content\n");
    await expect(installCapture({ home, screens: false })).rejects.toThrow("malformed");
    expect(readFileSync(rcPath, "utf8")).toBe("# >>> GenesisTools cmux capture >>>\nuser content\n");
    expect(existsSync(join(home, ".genesis-tools"))).toBe(false);
});

test("Bun selection prefers PATH over a transient macOS launcher execPath", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-bun-selection-"));
    const bun = join(directory, "bun");
    symlinkSync(process.argv[0], bun);
    expect(
        resolveCaptureBun({ searchPath: directory, execPath: "/fixture/gt-macos", argv0: "/fixture/gt-macos" })
    ).toBe(bun);
    expect(
        resolveCaptureBun({ searchPath: "/nonexistent", execPath: "/fixture/gt-macos", argv0: process.argv[0] })
    ).toBe(process.argv[0]);
    expect(() =>
        resolveCaptureBun({ searchPath: "/nonexistent", execPath: "/fixture/gt-macos", argv0: "/fixture/gt-macos" })
    ).toThrow("Bun executable");
});

test("reinstall updates a stable runtime entrypoint without rewriting shell configuration", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-runtime-update-"));
    const source = join(home, "example-recorder.ts");
    writeFileSync(source, 'process.stdout.write("version-one");');
    const first = await installCapture({ home, screens: false, recorderEntrypoint: source });
    const hook = readFileSync(first.hookPath, "utf8");
    const rc = readFileSync(first.rcPath, "utf8");
    const entry = join(home, ".genesis-tools/cmux/runtime/capture-record.js");
    expect(existsSync(entry)).toBe(true);
    writeFileSync(source, 'process.stdout.write("version-two");');
    const second = await installCapture({ home, screens: false, recorderEntrypoint: source });
    expect(second.runtimePath).not.toBe(first.runtimePath);
    expect(readFileSync(second.rcPath, "utf8")).toBe(rc);
    expect(readFileSync(second.hookPath, "utf8")).toBe(hook);
    const proc = Bun.spawn([process.execPath, entry], { cwd: "/private/tmp", stdout: "pipe", stderr: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("version-two");
    expect(await proc.exited).toBe(0);
});

test("an rc edit after preview refuses installation before writing artifacts", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-preview-race-"));
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "export EXAMPLE_SETTING=newer\n");
    await expect(
        installCapture({ home, screens: false, expectedRc: "export EXAMPLE_SETTING=older\n" })
    ).rejects.toThrow("changed after preview");
    expect(readFileSync(rc, "utf8")).toBe("export EXAMPLE_SETTING=newer\n");
    expect(existsSync(join(home, ".genesis-tools/cmux/runtime"))).toBe(false);
});

test("reinstallation preserves a managed block with unrelated content appended after it", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-position-"));
    const rcPath = join(home, ".zshrc");
    await installCapture({ home, screens: false });
    const before = `${readFileSync(rcPath, "utf8")}\n# later configuration\nexport EXAMPLE=ok\n`;
    writeFileSync(rcPath, before);
    const result = await installCapture({ home, screens: false });
    expect(result.changed).toBe(false);
    expect(readFileSync(rcPath, "utf8")).toBe(before);
});

test("uninstall retains the separator between surrounding rc statements", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-separator-"));
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "export FIRST=one");
    await installCapture({ home, screens: false });
    writeFileSync(rcPath, `${readFileSync(rcPath, "utf8")}export SECOND=two\n`);
    uninstallCapture({ home });
    expect(readFileSync(rcPath, "utf8")).toBe("export FIRST=one\nexport SECOND=two\n");
});
