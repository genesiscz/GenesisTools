import { runCmux, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";

export function isShellPromptReady(text: string): boolean {
    if (/Claude Code|OpenAI Codex|(?:^|\n)\s*Grok(?:\s+CLI|\s+v?\d|\s*$)/i.test(stripAnsi(text))) {
        return false;
    }
    const last =
        stripAnsi(text)
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .at(-1) ?? "";
    return (
        /^➜\s+\S+(?:\s+git:\([^)]*\))?(?:\s+✗)?\s*$/u.test(last) ||
        /^\[[^\]]+\]\s*[$#%]\s*$/u.test(last) ||
        /^[\w.-]+@[\w.-]+:\S*[$#%]\s*$/u.test(last) ||
        /^[a-zA-Z_][\w.-]*[%#$]\s*$/u.test(last) ||
        /^\s*[$#%❯]\s*$/u.test(last)
    );
}

export async function waitForTerminalText({
    workspaceRef,
    surfaceRef,
    matches,
    description,
    timeoutMs = 30_000,
    intervalMs = 200,
    activateOnUnavailable = false,
}: {
    workspaceRef: string;
    surfaceRef: string;
    matches: (text: string) => boolean;
    description: string;
    timeoutMs?: number;
    intervalMs?: number;
    activateOnUnavailable?: boolean;
}): Promise<void> {
    const started = Date.now();
    let activated = false;
    while (Date.now() - started < timeoutMs) {
        const result = await runCmux(["read-screen", "--workspace", workspaceRef, "--surface", surfaceRef], {
            timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
        });
        if (result.code === 0 && matches(result.stdout)) {
            logger.debug(
                { workspaceRef, surfaceRef, description, elapsedMs: Date.now() - started },
                "[restore] terminal ready"
            );
            return;
        }

        if (
            activateOnUnavailable &&
            !activated &&
            result.code !== 0 &&
            result.stderr.includes("Failed to read terminal text")
        ) {
            activated = true;
            try {
                await runCmuxOk(["rpc", "surface.focus", SafeJSON.stringify({ surface_id: surfaceRef })]);
            } catch (error) {
                logger.warn(
                    { error, surfaceRef },
                    "[restore] optional terminal activation failed; continuing readiness polling"
                );
            }
        }

        await Bun.sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for ${description} in ${workspaceRef} ${surfaceRef}; command was not replayed`);
}
