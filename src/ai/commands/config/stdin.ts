/**
 * Read a single value from stdin.
 *
 * Secrets arrive this way (or through a hidden prompt) and never on argv, where
 * they would land in shell history and in every `ps` on the machine.
 */
export async function readStdinValue(): Promise<string | undefined> {
    if (process.stdin.isTTY) {
        return undefined;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }

    const value = Buffer.concat(chunks).toString("utf8").trim();
    return value.length > 0 ? value : undefined;
}
