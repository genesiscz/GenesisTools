/**
 * Read a single value from stdin.
 *
 * Secrets arrive this way (or through a hidden prompt) and never on argv, where
 * they would land in shell history and in every `ps` on the machine.
 *
 * Exactly ONE trailing line ending is stripped, and nothing else. `echo foo |`
 * appends a newline the caller never typed, so removing it is the contract; a
 * blanket `.trim()` would additionally eat leading spaces and interior padding,
 * and callers store arbitrary vault values (passphrases, PEM blobs) whose bytes
 * have to survive verbatim. Emptiness is still judged after trimming, so a lone
 * newline or a few spaces still read as "nothing was piped".
 */
export async function readStdinValue(): Promise<string | undefined> {
    if (process.stdin.isTTY) {
        return undefined;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }

    const value = Buffer.concat(chunks)
        .toString("utf8")
        .replace(/\r?\n$/, "");
    return value.trim().length > 0 ? value : undefined;
}
