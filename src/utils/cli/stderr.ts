/**
 * Write text to stderr and resolve once every byte is committed.
 * Mirrors writeStdout — useful when stderr is a pipe and the process may exit early.
 */
export function writeStderr(text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        process.stderr.write(text, (error?: Error | null) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}
