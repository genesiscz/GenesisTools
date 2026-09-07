import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { isShellPromptReady, waitForTerminalText } from "@app/cmux/lib/terminal-ready";
import * as cli from "@genesiscz/utils/cmux/lib/cli";

afterEach(() => mock.restore());

test("startup banners and agent input boxes are not a ready shell", () => {
    expect(isShellPromptReady("Last login: today\nYou have mail.\n")).toBe(false);
    expect(isShellPromptReady("Claude Code\n❯ \n")).toBe(false);
    expect(isShellPromptReady("➜  repo git:(main) ✗ \n")).toBe(true);
    expect(isShellPromptReady("➜  repo git:(main) ✗ command still running\n")).toBe(false);
});

test("waits through empty, unready, and unavailable screens before accepting the prompt", async () => {
    const read = spyOn(cli, "runCmux")
        .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "starting" })
        .mockResolvedValueOnce({ code: 0, stdout: "Last login: today", stderr: "" })
        .mockResolvedValue({ code: 0, stdout: "➜  repo ", stderr: "" });
    await waitForTerminalText({
        workspaceRef: "workspace:5",
        surfaceRef: "surface:40",
        matches: isShellPromptReady,
        description: "shell prompt",
        intervalMs: 1,
        timeoutMs: 1000,
    });
    expect(read).toHaveBeenCalledTimes(3);
});

test("times out without sending any command when the shell never becomes ready", async () => {
    spyOn(cli, "runCmux").mockResolvedValue({ code: 0, stdout: "Starting…", stderr: "" });
    const send = spyOn(cli, "runCmuxOk").mockRejectedValue(new Error("must not send"));
    await expect(
        waitForTerminalText({
            workspaceRef: "workspace:5",
            surfaceRef: "surface:40",
            matches: isShellPromptReady,
            description: "shell prompt",
            intervalMs: 1,
            timeoutMs: 5,
        })
    ).rejects.toThrow("surface:40");
    expect(send).not.toHaveBeenCalled();
});

// Regression test: 2026-09-07 user report — unreadable dormant tabs start only on activation.
test("restore can activate a dormant terminal once before retrying its read", async () => {
    let active = false;
    spyOn(cli, "runCmux").mockImplementation(async () =>
        active
            ? { code: 0, stdout: "➜  repo ", stderr: "" }
            : { code: 1, stdout: "", stderr: "internal_error: Failed to read terminal text" }
    );
    const activate = spyOn(cli, "runCmuxOk").mockImplementation(async () => {
        active = true;
        return { code: 0, stdout: "", stderr: "" };
    });
    await waitForTerminalText({
        workspaceRef: "workspace:5",
        surfaceRef: "surface:40",
        matches: isShellPromptReady,
        description: "shell prompt",
        intervalMs: 1,
        timeoutMs: 2000,
        activateOnUnavailable: true,
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[0]).toEqual(["rpc", "surface.focus", '{"surface_id":"surface:40"}']);
});

test("read-only waits never activate a terminal with unavailable text", async () => {
    spyOn(cli, "runCmux").mockResolvedValue({ code: 1, stdout: "", stderr: "Failed to read terminal text" });
    const activate = spyOn(cli, "runCmuxOk").mockRejectedValue(new Error("must not activate"));
    await expect(
        waitForTerminalText({
            workspaceRef: "workspace:5",
            surfaceRef: "surface:40",
            matches: isShellPromptReady,
            description: "shell prompt",
            intervalMs: 1,
            timeoutMs: 5,
        })
    ).rejects.toThrow("Timed out");
    expect(activate).not.toHaveBeenCalled();
});

test("ordinary default and two-line shell prompts are recognized", () => {
    for (const prompt of ["host% ", "$ ", "# ", "project on main\n❯ ", "user@host ~/project\n$ "]) {
        expect(isShellPromptReady(prompt)).toBe(true);
    }
});

test("a failed optional focus RPC does not abort readiness polling", async () => {
    spyOn(cli, "runCmux")
        .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Failed to read terminal text" })
        .mockResolvedValue({ code: 0, stdout: "host% ", stderr: "" });
    const activate = spyOn(cli, "runCmuxOk").mockRejectedValue(new Error("focus unavailable"));
    await waitForTerminalText({
        workspaceRef: "workspace:5",
        surfaceRef: "surface:40",
        matches: isShellPromptReady,
        description: "shell",
        intervalMs: 1,
        timeoutMs: 2000,
        activateOnUnavailable: true,
    });
    expect(activate).toHaveBeenCalledTimes(1);
});

test("agent-screen rejection applies to every supported prompt shape", () => {
    for (const prompt of ["➜ repo", "[status]#", "user@host:path$", "host%", "❯"]) {
        expect(isShellPromptReady(`Claude Code\n${prompt}`)).toBe(false);
    }
    expect(isShellPromptReady("100%")).toBe(false);
    expect(isShellPromptReady("➜ grok")).toBe(true);
});
