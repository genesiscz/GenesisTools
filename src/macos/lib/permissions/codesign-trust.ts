import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { findProcesses } from "@genesiscz/utils/process/processes";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";

/**
 * The process that draws the keychain's dialog ("codesign wants to sign using key … in your keychain"). It runs only
 * while a security dialog is up, so a sign that is merely slow does not start it.
 */
const KEYCHAIN_DIALOG_PROCESS = "SecurityAgent";

/** True while macOS shows a security dialog, the keychain's password dialog among them. */
export function keychainDialogOpen(): boolean {
    return findProcesses({ name: KEYCHAIN_DIALOG_PROCESS }).length > 0;
}

/** The script a click on the build's codesign notice opens. */
export function codesignTrustLauncherPath(): string {
    return join(genesisAppDir(), "codesign-trust.command");
}

/**
 * Writes the launcher when its text changed. macOS opens a `.command` file in the terminal app the user picked for
 * shell scripts (Terminal unless changed), so a click needs no Automation grant for a terminal.
 */
export function writeCodesignTrustLauncher(tools = toolsEntrypoint()): string {
    const path = codesignTrustLauncherPath();
    const body = [
        "#!/bin/zsh -l",
        '# Opened by a click on the GenesisTools notice "codesign needs the keychain". It explains the codesign trust,',
        "# asks before it changes anything, and shows the result.",
        `exec ${shellCommandLine([tools, "macos", "permissions", "codesign-trust", "--from-notice"])}`,
        "",
    ].join("\n");

    if (!existsSync(path) || readFileSync(path, "utf8") !== body) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
    }

    chmodSync(path, 0o755);
    return path;
}

/** The shell line a click on the notice runs: the launcher, opened in the user's terminal app. */
export function codesignTrustClickCommand(): string {
    return shellCommandLine(["/usr/bin/open", writeCodesignTrustLauncher()]);
}

/**
 * The labels of the keys `security set-key-partition-list` changed. It prints one block per key, starting with
 * `keychain: "<path>"`; the key's label is attribute `0x00000001`. A key without a label is `(no label)`.
 */
export function changedKeyLabels(stdout: string): string[] {
    return stdout
        .split(/^keychain: "/m)
        .slice(1)
        .map((block) => /^\s*0x00000001 <blob>="([^"]*)"/m.exec(block)?.[1] || "(no label)");
}

export interface CodesignKeyProbe {
    ok: boolean;
    ms: number;
    /** The keychain's dialog was up while codesign ran. */
    dialog: boolean;
    detail: string;
}

/**
 * Signs a small file with `sign` (a certificate's SHA-1 or name) once, to show whether codesign reaches the key
 * without the keychain dialog. The file is plain text, never run: codesign keeps its signature in extended attributes.
 */
export async function probeCodesignKey({
    sign,
    timeoutMs = 30_000,
    dialogOpen = keychainDialogOpen,
    runCommand = boundedCommand,
}: {
    sign: string;
    timeoutMs?: number;
    dialogOpen?: () => boolean;
    runCommand?: typeof boundedCommand;
}): Promise<CodesignKeyProbe> {
    const file = join(genesisAppDir(), "codesign-trust-probe.txt");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "GenesisTools codesign trust probe\n");
    let dialog = false;
    const watch = setInterval(() => {
        dialog ||= dialogOpen();
    }, 500);
    const started = performance.now();

    try {
        const result = await runCommand({
            command: ["codesign", "--force", "--sign", sign, "--timestamp=none", file],
            timeoutMs,
        });
        const ms = Math.round(performance.now() - started);
        dialog ||= dialogOpen();
        const failure = result.error ? result.error.message : result.status === 0 ? "" : `exit ${result.status}`;

        return { ok: failure === "", ms, dialog, detail: [result.stderr.trim(), failure].filter(Boolean).join("\n") };
    } finally {
        clearInterval(watch);
    }
}
