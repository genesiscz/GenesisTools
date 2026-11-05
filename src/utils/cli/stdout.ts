/** Whether a stream error means its reader closed the pipe. */
export function isBrokenPipe(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EPIPE";
}

let listening = false;
const pendingWrites = new Set<(error: Error) => void>();
const callbackErrors = new WeakSet<Error>();

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
        // Bun can emit the same error after invoking the write callback.
        process.stdout.on("error", (error) => {
            if (callbackErrors.has(error)) {
                return;
            }
            if (pendingWrites.size === 0) {
                if (!isBrokenPipe(error)) {
                    throw error;
                }
                return;
            }
            for (const fail of pendingWrites) {
                fail(error);
            }
        });
    }
    await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
            pendingWrites.delete(fail);
            reject(error);
        };
        pendingWrites.add(fail);
        try {
            process.stdout.write(text, (error?: Error | null) => {
                pendingWrites.delete(fail);
                if (error) {
                    callbackErrors.add(error);
                    reject(error);
                } else {
                    resolve();
                }
            });
        } catch (error) {
            pendingWrites.delete(fail);
            if (error instanceof Error) {
                callbackErrors.add(error);
            }
            reject(error);
        }
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
