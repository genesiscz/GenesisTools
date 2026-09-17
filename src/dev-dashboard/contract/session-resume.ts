/**
 * The exact command Genesis' MonitorModel.resumeCommand builds, so both UIs copy one string.
 *
 * It lives in the contract, not in lib/session-focus.ts, because the /qa card renders it in
 * the browser. Importing it from session-focus.ts dragged that module's child-process spawn
 * and the node logger
 * (pino + @clack/prompts) into the Vite bundle, and `globalThis.process.platform` threw at
 * module-evaluation time, so the whole dashboard stopped mounting.
 */
export function resumeCommandFor(sessionId: string): string {
    return `tools claude run --resume ${sessionId}`;
}
