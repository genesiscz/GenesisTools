import { runCmux, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";

/**
 * Shell prompts that carry context (a directory, a host, a git branch), each with the typed text, if any, as group 1.
 * No agent UI draws these, so a screen whose last line is one of them is a shell, whatever older lines show.
 */
const CONTEXT_PROMPTS: readonly RegExp[] = [
    /^➜\s+\S+(?:\s+git:\([^)]*\))?(?:\s+✗)?(?:\s+(\S.*?))?\s*$/u,
    /^\[[^\]]+\]\s*[$#%](?:\s+(\S.*?))?\s*$/u,
    /^[\w.-]+@[\w.-]+:\S*[$#%](?:\s+(\S.*?))?\s*$/u,
    // macOS ships `PS1="%n@%m %1~ %# "`, so an untouched default shell prints
    // `user@host ~ %` — space separated, no colon.
    /^[\w.-]+@[\w.-]+(?:\s+\S+)+?\s+[%#$](?:\s+(\S.*?))?\s*$/u,
];

/** Bare prompts (`name%`, `$`, `❯`). An agent's input box draws the same glyphs. */
const BARE_PROMPTS: readonly RegExp[] = [/^[a-zA-Z_][\w.-]*[%#$]\s*$/u, /^\s*[$#%❯]\s*$/u];

const AGENT_UI = /Claude Code|OpenAI Codex|(?:^|\n)\s*Grok(?:\s+CLI|\s+v?\d|\s*$)/i;

/** What a terminal's last line shows: an empty shell prompt, a shell prompt with typed text, or anything else. */
export type PromptState = { kind: "empty" } | { kind: "typed"; text: string } | { kind: "unknown" };

/** Classify the last visible line as an empty shell prompt, typed prompt or unknown terminal state without trusting agent UI glyphs. */
export function classifyPrompt(screen: string): PromptState {
    const clean = stripAnsi(screen);
    const last =
        clean
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .at(-1) ?? "";

    for (const pattern of CONTEXT_PROMPTS) {
        const match = pattern.exec(last);

        if (match) {
            return match[1] ? { kind: "typed", text: match[1] } : { kind: "empty" };
        }
    }

    // A bare glyph is a shell only while no agent UI is on screen: Claude Code's input box is `❯ `.
    if (BARE_PROMPTS.some((pattern) => pattern.test(last)) && !AGENT_UI.test(clean)) {
        return { kind: "empty" };
    }

    return { kind: "unknown" };
}

/** Accept only terminal text classified as an empty shell prompt for command replay. */
export function isShellPromptReady(text: string): boolean {
    return classifyPrompt(text).kind === "empty";
}

/** Wait within a deadline for target terminal text, optionally activating an unavailable surface when explicitly allowed. */
export async function waitForTerminalText({
    workspaceId,
    surfaceId,
    matches,
    description,
    timeoutMs = 30_000,
    intervalMs = 200,
    activateOnUnavailable = false,
}: {
    workspaceId: string;
    surfaceId: string;
    matches: (text: string) => boolean;
    description: string;
    timeoutMs?: number;
    intervalMs?: number;
    activateOnUnavailable?: boolean;
}): Promise<void> {
    const started = Date.now();
    let activated = false;
    while (Date.now() - started < timeoutMs) {
        const result = await runCmux(["read-screen", "--workspace", workspaceId, "--surface", surfaceId], {
            timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
        });
        if (result.code === 0 && matches(result.stdout)) {
            logger.debug(
                { workspaceId, surfaceId, description, elapsedMs: Date.now() - started },
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
                await runCmuxOk(["rpc", "surface.focus", SafeJSON.stringify({ surface_id: surfaceId })]);
            } catch (error) {
                logger.warn(
                    { error, surfaceId },
                    "[restore] optional terminal activation failed; continuing readiness polling"
                );
            }
        }

        await Bun.sleep(intervalMs);
    }

    throw new Error(`Timed out waiting for ${description} in ${workspaceId} ${surfaceId}; command was not replayed`);
}
