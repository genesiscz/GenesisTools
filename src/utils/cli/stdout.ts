/**
 * Write text to stdout and resolve only once every byte is committed.
 *
 * Bun leaves a piped stdout fd in non-blocking mode. A plain `console.log` of a
 * large string can race process exit and be truncated at the OS pipe buffer
 * when the consumer is slow to drain.
 *
 * Awaiting the stream write callback gives stdout a chance to drain before the
 * action handler returns. `fs.writeSync(1, ...)` is not a safe replacement here;
 * it can throw EAGAIN on Bun's non-blocking pipe fd.
 */
export async function writeStdout(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (error?: Error | null) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

export async function printLn(text: string | string[] = ""): Promise<void> {
    await writeStdout(`${Array.isArray(text) ? text.join("\n") : text}\n`);
}
