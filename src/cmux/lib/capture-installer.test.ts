import { expect, spyOn, test } from "bun:test";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
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
import { buildOfflinePanes } from "@app/cmux/lib/offline-snapshot";
import { SafeJSON } from "@genesiscz/utils/json";

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
    const direct = Bun.spawn(
        [
            resolveCaptureBun(),
            result.runtimePath!,
            "completed",
            "44444444-4444-4444-8444-444444444444",
            home,
            "",
            "0",
            join(home, ".genesis-tools/cmux/command-journal"),
        ],
        {
            cwd: tmpdir(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { HOME: home, GENESIS_TOOLS_HOME: home, PATH: "/usr/bin:/bin" },
        }
    );
    direct.stdin.write("printf direct-runtime");
    direct.stdin.end();
    const [directCode, directError] = await Promise.all([
        direct.exited,
        new Response(direct.stderr).text(),
        new Response(direct.stdout).text(),
    ]);
    expect({ directCode, directError }).toEqual({ directCode: 0, directError: "" });
    expect(
        loadCapturedCommands({ directory: join(home, ".genesis-tools/cmux/command-journal") }).get(
            "44444444-4444-4444-8444-444444444444"
        )?.command
    ).toBe("printf direct-runtime");
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        cwd: tmpdir(),
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
    const proc = Bun.spawn([process.execPath, entry], {
        env: process.env,
        cwd: tmpdir(),
        stdout: "pipe",
        stderr: "pipe",
    });
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

test("a malformed manifest is reported invalid and repaired by reinstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-manifest-repair-"));
    await installCapture({ home, screens: false });
    writeFileSync(join(home, ".genesis-tools/cmux/runtime/installation.json"), "{broken");
    expect(captureInstallationStatus({ home }).runtimeValid).toBe(false);
    expect((await installCapture({ home, screens: false })).runtimeValid).toBe(true);
});

test("an rc edit during bundling cannot publish a new runtime link", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-install-race-"));
    await installCapture({ home, screens: false });
    const link = join(home, ".genesis-tools/cmux/runtime/capture-record.js");
    const originalLink = readlinkSync(link);
    const entry = join(home, "recorder.ts");
    writeFileSync(entry, 'process.stdout.write("new runtime");');
    const build = Bun.build.bind(Bun);
    const spy = spyOn(Bun, "build").mockImplementation(async (options) => {
        const result = await build(options);
        writeFileSync(join(home, ".zshrc"), "# changed during build\n");
        return result;
    });
    try {
        await expect(installCapture({ home, screens: false, recorderEntrypoint: entry })).rejects.toThrow(
            "changed during installation"
        );
        expect(readlinkSync(link)).toBe(originalLink);
        expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# changed during build\n");
    } finally {
        spy.mockRestore();
    }
});

test("commands-only shell startup associates identity for recovery after runtime IDs change", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-no-screens-identity-"));
    const runtimeId = "11111111-1111-4111-8111-111111111111";
    const stableId = "22222222-2222-4222-8222-222222222222";
    const installed = await installCapture({ home, screens: false });
    const native = join(home, "Library/Application Support/cmux");
    mkdirSync(native, { recursive: true });
    writeFileSync(
        join(native, "session-fixture.json"),
        SafeJSON.stringify({
            windows: [
                {
                    tabManager: {
                        workspaces: [
                            {
                                layout: { type: "pane", pane: { panelIds: [runtimeId] } },
                                panels: [{ id: runtimeId, stableSurfaceId: stableId, type: "terminal" }],
                            },
                        ],
                    },
                },
            ],
        })
    );
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/bin:/usr/bin", HOME: home, GENESIS_TOOLS_HOME: home, CMUX_SURFACE_ID: runtimeId },
    });
    proc.stdin.write(`source '${installed.hookPath}'\nprintf '%s' saved-command\n`);
    proc.stdin.end();
    const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(0);
    const directory = join(home, ".genesis-tools/cmux/command-journal");
    for (let attempt = 0; attempt < 100 && !existsSync(join(directory, `${runtimeId}.identity`)); attempt++) {
        await Bun.sleep(20);
    }
    const commands = loadCapturedCommands({ directory });
    expect(commands.get(stableId)?.stableSurfaceId).toBe(stableId);
    const nextId = "33333333-3333-4333-8333-333333333333";
    const panes = buildOfflinePanes(
        {
            layout: { type: "pane", pane: { panelIds: [nextId] } },
            panels: [{ id: nextId, stableSurfaceId: stableId, type: "terminal" }],
        },
        { x: 0, y: 0, width: 800, height: 600 },
        { ttyCommands: new Map(), surfaceSessions: new Map(), surfaceCommands: commands }
    );
    expect(panes[0].surfaces[0]).toMatchObject({
        command: "printf '%s' saved-command",
        command_source: "shell-journal",
    });
    expect(captureInstallationStatus({ home }).screens.enabled).toBe(false);
});

test("status detects and reinstall repairs a missing managed recorder symlink", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-link-repair-"));
    await installCapture({ home, screens: false });
    const entry = join(home, ".genesis-tools/cmux/runtime/capture-record.js");
    renameSync(entry, `${entry}.old`);
    expect(captureInstallationStatus({ home }).runtimeValid).toBe(false);
    expect((await installCapture({ home, screens: false })).runtimeValid).toBe(true);
});
