import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-listen");

/**
 * Say a decision out loud. Detached and never awaited: the listening loop must not wait on a
 * speech synthesiser, and a failure to speak can never change what was decided. `tools say` runs
 * from PATH on purpose, because speaking is not branch logic.
 */
export function speakDecision(text: string): void {
    const spoken = text.trim().slice(0, 200);
    if (spoken.length === 0) {
        return;
    }

    try {
        const child = Bun.spawn(["tools", "say", spoken, "--app", "jev"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
        });
        child.unref();
    } catch (error) {
        log.debug({ error }, "could not speak the decision; carrying on");
    }
}
