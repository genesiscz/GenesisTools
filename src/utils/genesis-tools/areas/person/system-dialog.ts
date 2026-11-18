import { statSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { appleScriptString } from "@genesiscz/utils/macos/jxa";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";

/**
 * The platform's own Approve or Cancel dialog (osascript, zenity or kdialog, PowerShell), started only from system
 * folders with a scrubbed environment, so an agent cannot answer it for the person. It is the `systemDialog` way of the
 * person area; rm's approval uses it today.
 */

/** What a dialog shows: its window title and its text. */
export interface SystemDialogText {
    title: string;
    body: string;
}

/** The dialog programs `PERSON_DIALOGS` looks for, for the line that says none was found. */
export const SYSTEM_DIALOG_PROGRAMS =
    "osascript on macOS, zenity or kdialog on Linux, PowerShell on Windows, each from its system folder only";

/** A dialog gives up after this long; the process is killed 10 s later if its program does not. */
export const DIALOG_GIVE_UP_S = 600;

export interface DialogResult {
    /** null when the process was killed (its deadline passed) instead of exiting. */
    exitCode: number | null;
    stdout: string;
    /** What the program wrote to stderr; osascript names a Cancel there (-128). */
    stderr?: string;
}

/**
 * What a person did with a dialog. Only `approved` and `cancelled` are a person's answer: `gave-up` is a dialog nobody
 * answered before its deadline, and `failed` is a program that could not show it.
 */
export type DialogAnswer = "approved" | "cancelled" | "gave-up" | "failed";

/** What a person dialog needs from the system. Tests pass a fake, so no dialog opens in a test. */
export interface DialogSystem {
    /** Whether `path` is a program only an administrator could have put there (`isTrustedDialogProgram`). */
    trusted: (path: string) => boolean;
    /** Runs `argv` with only the variables of `environment` until it exits; its exit code and stdout. */
    run: (argv: string[], environment: Record<string, string>) => DialogResult;
    /** A graphical session a window can open on (Linux: DISPLAY or WAYLAND_DISPLAY is set). */
    hasDisplay: () => boolean;
}

/** One platform's dialog, with Approve and Cancel and Cancel as the default button. */
export interface PersonDialog {
    /** The argv that shows the dialog, or null when no trusted program for it is installed. */
    command: (dialog: SystemDialogText, system: DialogSystem) => string[] | null;
    /** Reads the program's result: only an explicit Approve is `approved`, only an explicit Cancel is `cancelled`. */
    answer: (result: DialogResult) => DialogAnswer;
    /** The PATH the program runs with: the platform's system folders, never the caller's PATH. */
    searchPath: string;
}

/**
 * Where each dialog program may live: system folders only an administrator can write to. A dialog program is never
 * looked up on PATH: an agent can put its own folder first on PATH with a `zenity` (or `osascript`) that exits 0,
 * and its Approve would count as a person's. The Windows paths are fixed as well, since `SystemRoot` is a variable
 * an agent can set too.
 */
export const DIALOG_PROGRAM_PATHS = {
    osascript: ["/usr/bin/osascript"],
    zenity: ["/usr/bin/zenity", "/bin/zenity"],
    kdialog: ["/usr/bin/kdialog", "/bin/kdialog"],
    powershell: [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ],
} as const satisfies Record<string, readonly string[]>;

/**
 * A dialog program only an administrator could have put there: a regular file owned by root that neither its group
 * nor others may write (a symlink counts as the file it points to, and only root could place the link). Windows
 * reports no owner in `stat`: there the fixed paths under the Windows and Program Files folders, which only an
 * administrator may write, are the whole check.
 */
export function isTrustedDialogProgram(path: string, platform: NodeJS.Platform = process.platform): boolean {
    try {
        const stat = statSync(path, { throwIfNoEntry: false });

        if (!stat?.isFile()) {
            return false;
        }

        return platform === "win32" || (stat.uid === 0 && (stat.mode & 0o022) === 0);
    } catch (error) {
        logger.debug({ path, error }, "system dialog: cannot read a dialog program");
        return false;
    }
}

function trustedProgram(system: DialogSystem, paths: readonly string[]): string | null {
    return paths.find((path) => system.trusted(path)) ?? null;
}

/**
 * The variables a dialog program gets besides PATH: the session's display and message bus, the user's home and
 * language, and what Windows needs to start a program. Everything else stays behind: LD_PRELOAD, GTK_MODULES or a
 * PATH with the agent's folder first would run the agent's code inside the trusted program.
 */
const DIALOG_ENV_KEYS = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_MESSAGES",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "USERPROFILE",
    "TEMP",
    "TMP",
] as const;

/** The whole environment a dialog program starts with: `DIALOG_ENV_KEYS` that are set, and `searchPath` as PATH. */
export function dialogEnvironment(searchPath: string): Record<string, string> {
    const environment: Record<string, string> = { PATH: searchPath };

    for (const key of DIALOG_ENV_KEYS) {
        const value = env.get(key);

        if (value !== undefined) {
            environment[key] = value;
        }
    }

    return environment;
}

const MAC_DIALOG: PersonDialog = {
    command: ({ title, body }, system) => {
        const osascript = trustedProgram(system, DIALOG_PROGRAM_PATHS.osascript);
        const script =
            `display dialog ${appleScriptString(body)} with title ${appleScriptString(title)} ` +
            `buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ${DIALOG_GIVE_UP_S}`;
        return osascript ? [osascript, "-e", script] : null;
    },
    answer: ({ exitCode, stdout, stderr = "" }) => {
        if (exitCode === null || stdout.includes("gave up:true")) {
            return "gave-up";
        }

        if (exitCode === 0 && stdout.includes("button returned:Approve")) {
            return "approved";
        }

        // The Cancel button is the dialog's cancel button: osascript exits 1 with "User canceled. (-128)".
        return exitCode !== 0 && stderr.includes("(-128)") ? "cancelled" : "failed";
    },
    searchPath: "/usr/bin:/bin",
};

/**
 * zenity (GNOME and most desktops), else kdialog (KDE). Both exit 0 only for Approve and 1 for Cancel or a closed
 * window; zenity exits 5 when its `--timeout` passes.
 */
const LINUX_DIALOG: PersonDialog = {
    command: ({ title, body }, system) => {
        if (!system.hasDisplay()) {
            return null;
        }

        const zenity = trustedProgram(system, DIALOG_PROGRAM_PATHS.zenity);

        if (zenity) {
            // --no-markup: a path with < or & is shown as it is, not read as Pango markup.
            return [
                zenity,
                "--question",
                `--title=${title}`,
                `--text=${body}`,
                "--no-markup",
                "--ok-label=Approve",
                "--cancel-label=Cancel",
                "--default-cancel",
                `--timeout=${DIALOG_GIVE_UP_S}`,
                "--width=640",
            ];
        }

        const kdialog = trustedProgram(system, DIALOG_PROGRAM_PATHS.kdialog);
        return kdialog
            ? [kdialog, "--title", title, "--warningyesno", body, "--yes-label", "Approve", "--no-label", "Cancel"]
            : null;
    },
    answer: ({ exitCode }) => {
        if (exitCode === 0) {
            return "approved";
        }

        if (exitCode === 1) {
            return "cancelled";
        }

        return exitCode === null || exitCode === 5 ? "gave-up" : "failed";
    },
    searchPath: "/usr/bin:/bin",
};

/**
 * A Windows Forms message box through PowerShell, No as the default button. The text and the title go in as base64, so
 * a path with quotes (a typographic one too) or `$` is never read as PowerShell.
 */
const WINDOWS_DIALOG: PersonDialog = {
    command: ({ title, body }, system) => {
        const powershell = trustedProgram(system, DIALOG_PROGRAM_PATHS.powershell);

        if (!powershell) {
            return null;
        }

        const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
        const script = [
            "Add-Type -AssemblyName System.Windows.Forms",
            `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(`${body}\n\nYes approves.`)}'))`,
            `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(title)}'))`,
            "[System.Windows.Forms.MessageBox]::Show($text, $title, 'YesNo', 'Warning', 'Button2', 'DefaultDesktopOnly')",
        ].join("; ");
        return [powershell, "-NoProfile", "-Command", script];
    },
    answer: ({ exitCode, stdout }) => {
        if (exitCode === null) {
            return "gave-up";
        }

        if (exitCode !== 0) {
            return "failed";
        }

        const button = stdout.trim();
        return button === "Yes" ? "approved" : button === "No" ? "cancelled" : "failed";
    },
    searchPath: "C:\\Windows\\System32;C:\\Windows",
};

/** The dialog each platform asks a person with; a platform missing here has none. */
export const PERSON_DIALOGS: Partial<Record<NodeJS.Platform, PersonDialog>> = {
    darwin: MAC_DIALOG,
    linux: LINUX_DIALOG,
    win32: WINDOWS_DIALOG,
};

export const DIALOG_SYSTEM: DialogSystem = {
    trusted: (path) => isTrustedDialogProgram(path),
    run: (argv, environment) => {
        refuseHostEffectInTest("The system dialog", "Inject a DialogSystem in tests.");
        const proc = Bun.spawnSync(argv, {
            env: environment,
            stdout: "pipe",
            stderr: "pipe",
            timeout: (DIALOG_GIVE_UP_S + 10) * 1000,
        });
        return {
            exitCode: proc.exitCode,
            stdout: new TextDecoder().decode(proc.stdout),
            stderr: new TextDecoder().decode(proc.stderr),
        };
    },
    hasDisplay: () => env.device.hasGraphicalDisplay(),
};

/**
 * Shows `text` in the platform's dialog: true for Approve, false for anything else, null when the platform has no
 * dialog program (or no display to show it on).
 */
export function showSystemDialog(
    text: SystemDialogText,
    platform: NodeJS.Platform = process.platform,
    system: DialogSystem = DIALOG_SYSTEM
): boolean | null {
    const dialog = PERSON_DIALOGS[platform];
    const argv = dialog?.command(text, system) ?? null;

    if (!dialog || !argv) {
        logger.debug({ platform }, "system dialog: no dialog program to ask a person with");
        return null;
    }

    const result = system.run(argv, dialogEnvironment(dialog.searchPath));
    logger.debug(
        { program: argv[0], exitCode: result.exitCode, answer: result.stdout.trim() },
        "system dialog: answered"
    );
    return dialog.answer(result) === "approved";
}
