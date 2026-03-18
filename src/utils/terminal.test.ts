import { describe, expect, test } from "bun:test";
import { detectTerminalApp } from "./terminal";

describe("detectTerminalApp", () => {
    function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
        const saved: Record<string, string | undefined> = {};

        for (const key of Object.keys(overrides)) {
            saved[key] = process.env[key];
        }

        try {
            for (const [key, value] of Object.entries(overrides)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }

            fn();
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    }

    test("returns 'cmux' when CMUX_BUNDLE_ID is set", () => {
        withEnv({ CMUX_BUNDLE_ID: "com.example.cmux", TERM_PROGRAM: "" }, () => {
            expect(detectTerminalApp()).toBe("cmux");
        });
    });

    test("CMUX_BUNDLE_ID takes priority over TERM_PROGRAM", () => {
        withEnv({ CMUX_BUNDLE_ID: "com.example.cmux", TERM_PROGRAM: "ghostty" }, () => {
            expect(detectTerminalApp()).toBe("cmux");
        });
    });

    test("returns 'iTerm' for iTerm.app", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "iTerm.app" }, () => {
            expect(detectTerminalApp()).toBe("iTerm");
        });
    });

    test("returns 'iTerm' for iTerm2", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "iTerm2" }, () => {
            expect(detectTerminalApp()).toBe("iTerm");
        });
    });

    test("returns 'Terminal' for Apple_Terminal", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "Apple_Terminal" }, () => {
            expect(detectTerminalApp()).toBe("Terminal");
        });
    });

    test("returns 'Warp' for WarpTerminal", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "WarpTerminal" }, () => {
            expect(detectTerminalApp()).toBe("Warp");
        });
    });

    test("returns 'Visual Studio Code' for vscode", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "vscode" }, () => {
            expect(detectTerminalApp()).toBe("Visual Studio Code");
        });
    });

    test("returns 'Visual Studio Code' for vscode-insiders", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "vscode-insiders" }, () => {
            expect(detectTerminalApp()).toBe("Visual Studio Code");
        });
    });

    test("returns 'Ghostty' for ghostty", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "ghostty" }, () => {
            expect(detectTerminalApp()).toBe("Ghostty");
        });
    });

    test("returns 'tmux (and your outer terminal)' for tmux", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "tmux" }, () => {
            expect(detectTerminalApp()).toBe("tmux (and your outer terminal)");
        });
    });

    test("returns the raw TERM_PROGRAM for unknown terminals", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "Alacritty" }, () => {
            expect(detectTerminalApp()).toBe("Alacritty");
        });
    });

    test("returns 'your terminal app' when TERM_PROGRAM is empty", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: "" }, () => {
            expect(detectTerminalApp()).toBe("your terminal app");
        });
    });

    test("returns 'your terminal app' when TERM_PROGRAM is unset", () => {
        withEnv({ CMUX_BUNDLE_ID: undefined, TERM_PROGRAM: undefined }, () => {
            expect(detectTerminalApp()).toBe("your terminal app");
        });
    });
});
