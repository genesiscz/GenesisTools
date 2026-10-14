import { basename } from "node:path";

/**
 * Why this process reads the vault, for the approval window GenesisTools.app shows before it hands the master key to a
 * tool. Martin, 2026-10-15: "enough context so i know exactly what / who / which session / triggered that and why
 * (each caller should give that context possibly)". WHO and WHICH SESSION the app reads from the kernel; WHY and WHAT
 * only the caller knows, so they live here.
 */
let purpose: string | undefined;
let firstSecret: string | undefined;

/** One sentence a person can judge: "refresh the usage figures of 11 accounts for the statusline". */
export function setVaultPurpose(text: string | undefined): void {
    purpose = text?.trim() || undefined;
}

/** The purpose for the duration of `fn`, then the one before it again. */
export async function withVaultPurpose<T>(text: string, fn: () => Promise<T>): Promise<T> {
    const previous = purpose;
    purpose = text.trim() || previous;

    try {
        return await fn();
    } finally {
        purpose = previous;
    }
}

export function vaultPurpose(): string | undefined {
    return purpose;
}

/** The first secret this process read: what it was after when it needed the master key. */
export function noteVaultSecret(path: string): void {
    firstSecret ??= path;
}

export function vaultSecretAsked(): string | undefined {
    return firstSecret;
}

/** Test seam. */
export function _resetVaultContextForTest(): void {
    purpose = undefined;
    firstSecret = undefined;
}

/**
 * The tool this process runs: `src/<tool>/` in the script path (`src/ai/commands/usage/poll-daemon.ts` is `ai`), else
 * the `gt-<tool>` launcher, else the script's own name. The first version read only `src/<tool>/index.ts` and called
 * the usage daemon "bun".
 */
export function currentToolName(argv: string[] = process.argv, executable: string = process.execPath): string {
    const script = argv[1] ?? "";
    const fromScript = script.match(/[/\\]src[/\\]([^/\\]+)[/\\]/)?.[1];

    if (fromScript) {
        return fromScript;
    }

    for (const launcher of [basename(executable), basename(argv[0] ?? "")]) {
        if (launcher.startsWith("gt-")) {
            return launcher.slice(3);
        }
    }

    return basename(script).replace(/\.[cm]?[jt]sx?$/, "") || basename(argv[0] ?? "") || "unknown";
}

/** `tools <tool> <args>`, cut to a length a window can show. Tokens never travel in argv (they go through stdin). */
export function currentCommandLine(argv: string[] = process.argv, max = 300): string {
    const words = ["tools", currentToolName(argv), ...argv.slice(2)].map((word) =>
        word.includes(" ") ? `"${word}"` : word
    );
    const line = words.join(" ");

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
