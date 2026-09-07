import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCapturedCommands } from "@app/cmux/lib/capture-journal";
import { renderCaptureShell } from "@app/cmux/lib/capture-shell";

test("zsh records a short-lived command before execution and preserves its exit status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-shell-test-"));
    const hook = join(directory, "hook.zsh");
    await Bun.write(
        hook,
        renderCaptureShell({
            bunPath: process.execPath,
            recorderPath: resolve("src/cmux/capture-record.ts"),
            directory,
        })
    );
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/bin:/usr/bin", HOME: directory, CMUX_SURFACE_ID: "11111111-1111-4111-8111-111111111111" },
    });
    proc.stdin.write(`source '${hook}'\nprintf '%s' 'two words'; false\n`);
    proc.stdin.end();
    const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(errors).not.toContain("command not found");
    expect(output).toContain("two words");
    expect(code).toBe(1);
    expect(loadCapturedCommands({ directory }).get("11111111-1111-4111-8111-111111111111")).toMatchObject({
        command: "printf '%s' 'two words'; false",
        phase: "completed",
        exitStatus: 1,
    });
});

test("the journal exists before a short-lived command can observe the filesystem", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-before-exec-test-"));
    const hook = join(directory, "hook.zsh");
    await Bun.write(
        hook,
        renderCaptureShell({
            bunPath: process.execPath,
            recorderPath: resolve("src/cmux/capture-record.ts"),
            directory,
        })
    );
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/bin:/usr/bin", HOME: directory, CMUX_SURFACE_ID: "11111111-1111-4111-8111-111111111111" },
    });
    proc.stdin.write(
        `source '${hook}'\n[[ -s '${directory}/11111111-1111-4111-8111-111111111111.jsonl' ]] && printf CAPTURED_BEFORE_EXEC\n`
    );
    proc.stdin.end();
    const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(errors).not.toContain("capture failed");
    expect(code).toBe(0);
    expect(output).toContain("CAPTURED_BEFORE_EXEC");
});

test("reserved restore setup leaves the last genuine command and its completion status intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-restore-exclusion-"));
    const hook = join(directory, "hook.zsh");
    await Bun.write(
        hook,
        renderCaptureShell({
            bunPath: process.execPath,
            recorderPath: resolve("src/cmux/capture-record.ts"),
            directory,
        })
    );
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/bin:/usr/bin", HOME: directory, CMUX_SURFACE_ID: "11111111-1111-4111-8111-111111111111" },
    });
    proc.stdin.write(
        `source '${hook}'\nprintf '%s' genuine; false\nfunction _genesis_cmux_restore_internal { cd /; printf '%s' cmux-ready; }; _genesis_cmux_restore_internal; unfunction _genesis_cmux_restore_internal\n`
    );
    proc.stdin.end();
    const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(errors).not.toContain("capture failed");
    expect(code).toBe(0);
    expect(output).toContain("genuinecmux-ready");
    expect(loadCapturedCommands({ directory }).get("11111111-1111-4111-8111-111111111111")).toMatchObject({
        command: "printf '%s' genuine; false",
        phase: "completed",
        exitStatus: 1,
    });
});

test("a user function with a similar name is still captured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-restore-exclusion-control-"));
    const hook = join(directory, "hook.zsh");
    await Bun.write(
        hook,
        renderCaptureShell({
            bunPath: process.execPath,
            recorderPath: resolve("src/cmux/capture-record.ts"),
            directory,
        })
    );
    const proc = Bun.spawn(["/bin/zsh", "-dfi"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/bin:/usr/bin", HOME: directory, CMUX_SURFACE_ID: "11111111-1111-4111-8111-111111111111" },
    });
    proc.stdin.write(
        `source '${hook}'\nfunction _genesis_cmux_restore_internal_user { printf '%s' real; }; _genesis_cmux_restore_internal_user\n`
    );
    proc.stdin.end();
    const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(errors).not.toContain("capture failed");
    expect(output).toContain("real");
    expect(code).toBe(0);
    expect(loadCapturedCommands({ directory }).get("11111111-1111-4111-8111-111111111111")?.command).toBe(
        "function _genesis_cmux_restore_internal_user { printf '%s' real; }; _genesis_cmux_restore_internal_user"
    );
});
