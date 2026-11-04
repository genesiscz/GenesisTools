import { execTool } from "@genesiscz/utils/cli/tools";
import { logger } from "@genesiscz/utils/logger";
import type { ChannelDefinition, SayChannelConfig } from "../types";

/**
 * How long `tools say` may run before its process group is stopped. Speaking a notification takes seconds. A run past
 * this is stuck: a child that never exits, or one that left a grandchild holding its stderr pipe open, and without a
 * deadline every caller of {@link dispatchNotification} waited on it forever.
 */
export const SAY_DISPATCH_TIMEOUT_MS = 120_000;

/** True when `tools say` spoke the message (or there was nothing to say). Never throws. */
export async function dispatchSay(
    message: string,
    config: SayChannelConfig,
    { timeoutMs = SAY_DISPATCH_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<boolean> {
    if (!config.enabled) {
        return true;
    }

    const voice = config.voice ?? "Samantha";
    const args = ["say", message, "--voice", voice];

    if (config.provider) {
        args.push("--provider", config.provider);
    }

    try {
        // execTool runs this checkout's tools (not whatever `tools` is on PATH) and stops its process group at the deadline.
        const result = await execTool(args, { timeout: timeoutMs });

        if (!result.success) {
            logger.warn(
                { exitCode: result.exitCode, timedOut: result.timedOut === true, stderr: result.stderr },
                "Say notification dispatch failed"
            );
            return false;
        }

        return true;
    } catch (err) {
        logger.warn({ err }, "Say notification dispatch failed");

        return false;
    }
}

export const sayChannel: ChannelDefinition<"say"> = {
    name: "say",
    label: "TTS (say)",
    defaults: { enabled: false },
    fields: { enabled: "boolean", voice: "string", provider: "string" },
    secretKeys: [],
    unusable: () => undefined,
    describe: (config) =>
        [config.voice ? `voice ${config.voice}` : "default voice", config.provider ? `via ${config.provider}` : null]
            .filter(Boolean)
            .join(" · "),
    post: async (event, config) => ({ ok: await dispatchSay(event.message, config) }),
    // Speech cannot be taken back.
    retract: async () => false,
};
