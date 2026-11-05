/** Whether a stream error means its reader closed the pipe. */
export function isBrokenPipe(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EPIPE";
}

let listening = false;

/**
 * Write text to stdout and reject if delivery fails.
 *
 * Bun leaves a piped stdout fd in non-blocking mode. A plain `console.log` of a
 * large string can race process exit and be truncated at the OS pipe buffer
 * when the consumer is slow to drain.
 *
 * Awaiting the stream write callback gives stdout a chance to drain before the
 * action handler returns. `fs.writeSync(1, ...)` is not a safe replacement here;
 * it can throw EAGAIN on Bun's non-blocking pipe fd.
 */
export async function writeStdoutStrict(text: string): Promise<void> {
    if (!listening) {
        listening = true;
        // Bun can emit the error after invoking the write callback.
        process.stdout.on("error", (error) => {
            if (!isBrokenPipe(error)) {
                throw error;
            }
        });
    }
    await new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (error?: Error | null) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

export async function writeStdout(text: string): Promise<void> {
    try {
        await writeStdoutStrict(text);
    } catch (error) {
        if (!isBrokenPipe(error)) {
            throw error;
        }
    }
}

export async function printLn(text: string | string[] = ""): Promise<void> {
    await writeStdout(`${Array.isArray(text) ? text.join("\n") : text}\n`);
}
