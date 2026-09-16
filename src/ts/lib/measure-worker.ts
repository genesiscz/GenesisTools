// The measuring process. It must import NOTHING from the repo before the clock starts: every
// module already in this process's cache is a module whose cost the measurement can no longer
// see. That is why the protocol is tab-separated lines in a file, not SafeJSON, and why the
// plan comes in through environment variables rather than a parsed argv.
//
//   GT_TS_PLAN   file with one absolute module path per line, children before parents
//   GT_TS_OUT    file to append results to, one `<index>\t<ms>\t<status>[\t<message>]` line each
//   GT_TS_MODE   "each" (default) imports every plan line in order; "cold" imports only the last
//   GT_TS_MODULE_MS  per-module deadline; one module that never returns costs one deadline
//
// A module that calls process.exit() during import (a CLI entrypoint parsing argv) is reported
// as `exit <code>` instead of killing the run, and the results file is appended line by line so
// a module that never returns still leaves everything before it on disk.
//
// 🛑 Two things an entrypoint does at import time used to hang the whole run, both found on
// `tools ai`:
//
//   - argv was emptied, and commander runs the DEFAULT action for an empty argv. `tools ai`'s
//     default action opens a clack `select`, which waits on a stdin that is /dev/null here, so
//     the import never settled and both the `each` and the `cold` worker were killed at the
//     outer timeout. argv now carries `--help`, which every `runTool` entrypoint answers by
//     printing and exiting, and which is also the argv that loads every subcommand tree.
//   - even with that, ANY module may await something that never resolves. Each import is now
//     raced against its own deadline and reported as `hang`, so one bad module costs one
//     deadline instead of the entire measurement. A module that blocks the event loop
//     SYNCHRONOUSLY still needs the outer worker timeout, which stays as the backstop.

import { appendFileSync, readFileSync } from "node:fs";

const planPath = process.env.GT_TS_PLAN;
const outPath = process.env.GT_TS_OUT;
const mode = process.env.GT_TS_MODE === "cold" ? "cold" : "each";

if (!planPath || !outPath) {
    process.stderr.write("measure-worker: GT_TS_PLAN and GT_TS_OUT are required\n");
    process.exit(2);
}

const plan = readFileSync(planPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);

// Commander-based entrypoints call process.exit() after printing help for an empty argv. Make
// that a catchable signal so the import time is still recorded and the run continues.
class ExitDuringImport extends Error {
    constructor(readonly code: number) {
        super(`process.exit(${code}) called during import`);
    }
}

const realExit = process.exit.bind(process);
process.exit = ((code?: number | string | null) => {
    throw new ExitDuringImport(typeof code === "number" ? code : 0);
}) as typeof process.exit;
// `--help` rather than nothing: an empty argv runs commander's default action, and a default
// action that prompts never returns. Every `runTool` entrypoint registers `--help`, answers it
// by printing and calling process.exit (caught below as `exit 0`), and — since argv-gated
// registration landed — loads every subcommand tree for it, which is what a cost analysis of an
// entrypoint wants to see.
process.argv = [process.argv[0], process.argv[1], "--help"];

const MODULE_TIMEOUT_MS = Number.parseInt(process.env.GT_TS_MODULE_MS ?? "", 10) || 10_000;

function record(index: number, ms: number, status: string, message?: string): void {
    const tail = message === undefined ? "" : `\t${message.replace(/[\t\n\r]+/g, " ").slice(0, 400)}`;
    appendFileSync(outPath as string, `${index}\t${ms.toFixed(3)}\t${status}${tail}\n`);
}

const HUNG = Symbol("hung");

async function importOne(index: number, file: string): Promise<void> {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        // The import keeps running after the race is lost — an ES module evaluation cannot be
        // cancelled — but nothing waits on it, and `realExit` below ends the process. Its self
        // time is unknown, not zero, which is what `hang` means to the reader.
        const raced = await Promise.race([
            import(file),
            new Promise<typeof HUNG>((resolve) => {
                timer = setTimeout(() => resolve(HUNG), MODULE_TIMEOUT_MS);
            }),
        ]);

        if (raced === HUNG) {
            record(index, performance.now() - started, "hang", `no settle in ${MODULE_TIMEOUT_MS} ms`);
            return;
        }

        record(index, performance.now() - started, "ok");
    } catch (error) {
        const elapsed = performance.now() - started;

        if (error instanceof ExitDuringImport) {
            record(index, elapsed, "exit", String(error.code));
            return;
        }

        record(index, elapsed, "error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    } finally {
        clearTimeout(timer);
    }
}

if (mode === "cold") {
    const last = plan.length - 1;
    await importOne(last, plan[last]);
} else {
    for (let index = 0; index < plan.length; index++) {
        await importOne(index, plan[index]);
    }
}

// Modules that armed timers or opened watchers would keep this process alive forever.
realExit(0);
