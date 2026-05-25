/** Plain stderr lines — no clack borders. Safe beside piped/tee child stdout. */
export function statusLine(line = ""): void {
    process.stderr.write(`${line}\n`);
}

export function statusError(message: string): void {
    process.stderr.write(`error: ${message}\n`);
}
