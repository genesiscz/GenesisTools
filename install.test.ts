import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "install.sh");

/**
 * Sources install.sh (the `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard keeps that from running the
 * whole installer) and then runs `call` with the given env. Fresh temp HOME per call, so a
 * created rc file in one test can never be read back by another.
 */
function runBash({
    home,
    shellValue,
    ostype,
    pathPrepend,
    setup = "",
    call,
}: {
    home: string;
    shellValue: string;
    ostype?: string;
    pathPrepend?: string;
    setup?: string;
    call: string;
}): { code: number; stdout: string } {
    const script = [
        ostype ? `OSTYPE="${ostype}"` : "",
        `source "${INSTALL_SH}"`,
        'CURRENT_DIR="/tools-dir"',
        'TOOLS_LINE="export GENESIS_TOOLS_PATH=\\"$CURRENT_DIR\\""',
        'EXPORT_LINE="export PATH=\\"\\$GENESIS_TOOLS_PATH:\\$PATH\\""',
        "SHELL_CONFIG_CHANGED=false",
        setup,
        call,
    ]
        .filter(Boolean)
        .join("\n");

    const proc = Bun.spawnSync(["bash", "-c", script], {
        env: {
            ...process.env,
            HOME: home,
            SHELL: shellValue,
            PATH: pathPrepend ? `${pathPrepend}:${process.env.PATH}` : process.env.PATH,
        },
        stdout: "pipe",
        stderr: "pipe",
    });

    return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout) };
}

function tempHome(): string {
    return mkdtempSync(join(tmpdir(), "genesis-install-test-"));
}

/** A fake `xcode-select` on PATH, so detect_xcode_toolchain is testable without the real tool. */
function fakeXcodeSelect(devDir: string | null): string {
    const bin = mkdtempSync(join(tmpdir(), "genesis-install-xcode-"));
    const script = join(bin, "xcode-select");

    writeFileSync(script, devDir === null ? "#!/bin/sh\nexit 2\n" : `#!/bin/sh\necho "${devDir}"\n`);
    chmodSync(script, 0o755);
    return bin;
}

describe("shell_rc_filename", () => {
    test.each([
        ["/bin/zsh", ".zshrc"],
        ["/usr/local/bin/zsh", ".zshrc"],
        ["/bin/bash", ".bashrc"],
        // `ps -o comm=` names a login shell "-zsh" and may print a bare name.
        ["-zsh", ".zshrc"],
        ["bash", ".bashrc"],
        ["/bin/fish", ""],
        ["", ""],
    ])("maps %s to %s", (shellValue, expected) => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue,
            call: `shell_rc_filename "${shellValue}"`,
        });

        expect(stdout.trim()).toBe(expected);
    });
});

describe("update_unix_shell_configs", () => {
    // Regression test: #446 item 11 — install.sh must not create ~/.bashrc for a zsh user.
    test("creates only the rc file belonging to $SHELL when neither exists", () => {
        const home = tempHome();
        runBash({ home, shellValue: "/bin/zsh", call: 'update_unix_shell_configs "$HOME" "$SHELL"' });

        expect(existsSync(join(home, ".zshrc"))).toBe(true);
        expect(existsSync(join(home, ".bashrc"))).toBe(false);
    });

    test("creates only .bashrc for a bash user, never .zshrc", () => {
        const home = tempHome();
        runBash({ home, shellValue: "/bin/bash", call: 'update_unix_shell_configs "$HOME" "$SHELL"' });

        expect(existsSync(join(home, ".bashrc"))).toBe(true);
        expect(existsSync(join(home, ".zshrc"))).toBe(false);
    });

    test("updates an rc file that already exists even when it is not $SHELL's own", () => {
        const home = tempHome();
        writeFileSync(join(home, ".bashrc"), "# pre-existing\n");

        runBash({
            home,
            shellValue: "/bin/zsh",
            call: 'update_unix_shell_configs "$HOME" "$SHELL"',
        });

        const bashrc = readFileSync(join(home, ".bashrc"), "utf8");
        expect(bashrc).toContain("# pre-existing");
        expect(bashrc).toContain("GENESIS_TOOLS_PATH");
        expect(existsSync(join(home, ".zshrc"))).toBe(true);
    });

    test("creates nothing for a shell it does not recognize", () => {
        const home = tempHome();
        runBash({ home, shellValue: "/usr/bin/fish", call: 'update_unix_shell_configs "$HOME" "$SHELL"' });

        expect(existsSync(join(home, ".zshrc"))).toBe(false);
        expect(existsSync(join(home, ".bashrc"))).toBe(false);
    });

    // Regression test: PR #457 review — $SHELL is the LOGIN shell. Running the installer from an
    // interactive bash on a zsh Mac configured only ~/.zshrc, so `tools` stayed missing in bash.
    test("also configures the shell the installer runs in when it differs from $SHELL", () => {
        const home = tempHome();
        runBash({ home, shellValue: "/bin/zsh", call: 'update_unix_shell_configs "$HOME" "$SHELL" "bash"' });

        expect(existsSync(join(home, ".zshrc"))).toBe(true);
        expect(existsSync(join(home, ".bashrc"))).toBe(true);
    });
});

describe("reload_rc_filename", () => {
    test("names the rc file of the shell the installer runs in, before the login shell's", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            call: 'reload_rc_filename "-bash" "$SHELL"',
        });

        expect(stdout.trim()).toBe(".bashrc");
    });

    test("falls back to the login shell when the invoking one is not a known shell", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            call: 'reload_rc_filename "make" "$SHELL"',
        });

        expect(stdout.trim()).toBe(".zshrc");
    });
});

describe("detect_xcode_toolchain", () => {
    test("reports xcode for a *.app/Contents/Developer path", () => {
        const bin = fakeXcodeSelect("/Applications/Xcode.app/Contents/Developer");
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            pathPrepend: bin,
            call: "detect_xcode_toolchain",
        });

        expect(stdout.trim()).toBe("xcode");
    });

    test("reports command-line-tools for a CommandLineTools path", () => {
        const bin = fakeXcodeSelect("/Library/Developer/CommandLineTools");
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            pathPrepend: bin,
            call: "detect_xcode_toolchain",
        });

        expect(stdout.trim()).toBe("command-line-tools");
    });

    test("reports none when xcode-select fails", () => {
        const bin = fakeXcodeSelect(null);
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            pathPrepend: bin,
            call: "detect_xcode_toolchain",
        });

        expect(stdout.trim()).toBe("none");
    });
});

describe("offer_genesis_app_build", () => {
    // Regression test: #445 — building GenesisTools.app must be asked for first, and must say why it
    // refuses on a Command Line Tools-only machine instead of letting swift build dump errors.
    test("does nothing on a non-darwin host", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "linux-gnu",
            call: 'offer_genesis_app_build; echo "built=$GENESIS_APP_BUILT"',
        });

        expect(stdout.trim()).toBe("built=false");
    });

    test("skips the build and explains, without asking, when only the Command Line Tools are present", () => {
        const bin = fakeXcodeSelect("/Library/Developer/CommandLineTools");
        const setup = `command() { if [ "$1" = -v ] && [ "$2" = swift ]; then return 0; fi; builtin command "$@"; }`;
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            pathPrepend: bin,
            setup,
            call: 'offer_genesis_app_build < /dev/null; echo "built=$GENESIS_APP_BUILT"',
        });

        expect(stdout).toContain("needs the full Xcode");
        expect(stdout.trim().endsWith("built=false")).toBe(true);
    });

    // Regression test: PR #457 review — the hint named /Applications/Xcode.app as the only path,
    // which fails for Xcode-beta.app or any other install location.
    test("does not prescribe one fixed Xcode path in the Command Line Tools hint", () => {
        const bin = fakeXcodeSelect("/Library/Developer/CommandLineTools");
        const setup = `command() { if [ "$1" = -v ] && [ "$2" = swift ]; then return 0; fi; builtin command "$@"; }`;
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            pathPrepend: bin,
            setup,
            call: "offer_genesis_app_build < /dev/null",
        });

        expect(stdout).not.toContain("xcode-select -s /Applications/Xcode.app");
    });

    // Regression test: PR #457 review — with no swift at all, the hint said to install only the
    // Command Line Tools, which the very next check refuses as unable to build the app.
    test("recommends the full Xcode, not the Command Line Tools, when swift is missing", () => {
        const setup = `command() { if [ "$1" = -v ] && [ "$2" = swift ]; then return 1; fi; builtin command "$@"; }`;
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            setup,
            call: 'offer_genesis_app_build < /dev/null; echo "built=$GENESIS_APP_BUILT"',
        });

        expect(stdout).toContain("full Xcode");
        expect(stdout).not.toContain("Install Xcode Command Line Tools");
        expect(stdout.trim().endsWith("built=false")).toBe(true);
    });

    test("skips the build and explains how to run it later when stdin is not a terminal", () => {
        const bin = fakeXcodeSelect("/Applications/Xcode.app/Contents/Developer");
        const setup = `command() { if [ "$1" = -v ] && [ "$2" = swift ]; then return 0; fi; builtin command "$@"; }`;
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            pathPrepend: bin,
            setup,
            call: 'offer_genesis_app_build < /dev/null; echo "built=$GENESIS_APP_BUILT"',
        });

        expect(stdout).toContain("bun run build:app");
        expect(stdout.trim().endsWith("built=false")).toBe(true);
    });
});

describe("print_genesis_app_summary", () => {
    // Regression test: #445 comment item 4 — the closing summary must say plainly when
    // GenesisTools.app is missing and what that means, not just "Setup complete".
    test("explains the terminal-permissions fallback when the app was not built", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            call: "GENESIS_APP_BUILT=false; print_genesis_app_summary",
        });

        expect(stdout).toContain("GenesisTools.app is not installed");
        expect(stdout).toContain("your terminal's own permissions");
    });

    test("says nothing once the app is built", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            call: "GENESIS_APP_BUILT=true; print_genesis_app_summary",
        });

        expect(stdout.trim()).toBe("");
    });

    // Regression test: PR #457 review — GENESIS_APP_BUILT only says whether THIS run built the
    // app, so declining the rebuild reported an app installed by an earlier run as missing.
    test("says the app is installed, not missing, when an earlier run installed it", () => {
        const home = tempHome();
        const macos = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
        mkdirSync(macos, { recursive: true });
        writeFileSync(join(macos, "GenesisTools"), "");

        const { stdout } = runBash({
            home,
            shellValue: "/bin/zsh",
            ostype: "darwin24",
            call: "GENESIS_APP_BUILT=false; print_genesis_app_summary",
        });

        expect(stdout).not.toContain("is not installed");
        expect(stdout).toContain("GenesisTools.app is installed");
    });

    test("says nothing on a non-darwin host, built or not", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            ostype: "linux-gnu",
            call: "GENESIS_APP_BUILT=false; print_genesis_app_summary",
        });

        expect(stdout.trim()).toBe("");
    });
});

describe("print_mcp_registration_hint", () => {
    // Regression test: #446/D4 round 2 — install.sh never mentioned registering the
    // genesis-tools MCP server, even though neither it nor the plugin install does so.
    test("names the canonical registration command", () => {
        const { stdout } = runBash({
            home: tempHome(),
            shellValue: "/bin/zsh",
            call: "print_mcp_registration_hint",
        });

        expect(stdout).toContain("tools genesis-tools-mcp install");
    });
});
