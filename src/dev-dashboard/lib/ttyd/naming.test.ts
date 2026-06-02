import { describe, expect, it } from "bun:test";
import { deriveTtydDisplayName, isMeaningfulCommand } from "@app/dev-dashboard/lib/ttyd/naming";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

function session(overrides: Partial<TtydSession>): TtydSession {
    return {
        id: "abc12345",
        port: 4001,
        command: "/bin/zsh",
        cwd: "/work",
        pid: 100,
        startedAt: "2026-06-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("isMeaningfulCommand", () => {
    it("rejects shells and empties", () => {
        for (const c of [undefined, "", "  ", "zsh", "bash", "-zsh", "login", "tmux"]) {
            expect(isMeaningfulCommand(c)).toBe(false);
        }
    });

    it("accepts real foreground processes", () => {
        for (const c of ["claude", "vim", "node", "nvim", "bun"]) {
            expect(isMeaningfulCommand(c)).toBe(true);
        }
    });
});

describe("deriveTtydDisplayName precedence (manual wins — auto never overwrites)", () => {
    it("a manual name beats a meaningful lastCommand", () => {
        const s = session({ name: "My Server", lastCommand: "vim", tmuxSessionName: "dev-dashboard-abc12345" });
        expect(deriveTtydDisplayName(s)).toBe("My Server");
    });

    it("auto-names from lastCommand when no manual name", () => {
        const s = session({ lastCommand: "claude", tmuxSessionName: "dev-dashboard-abc12345" });
        expect(deriveTtydDisplayName(s)).toBe("claude");
    });

    it("falls back to tmux session name when lastCommand is just a shell", () => {
        const s = session({ lastCommand: "zsh", tmuxSessionName: "dev-dashboard-abc12345" });
        expect(deriveTtydDisplayName(s)).toBe("dev-dashboard-abc12345");
    });

    it("falls back to command when there is no tmux binding and no meaningful command", () => {
        const s = session({ command: "/bin/zsh", lastCommand: "zsh" });
        expect(deriveTtydDisplayName(s)).toBe("/bin/zsh");
    });

    it("a whitespace-only manual name is treated as unset", () => {
        const s = session({ name: "   ", lastCommand: "node", tmuxSessionName: "t" });
        expect(deriveTtydDisplayName(s)).toBe("node");
    });
});
