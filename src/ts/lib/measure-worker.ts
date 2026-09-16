// The measuring process. It must import NOTHING from the repo before the clock starts: every
// module already in this process's cache is a module whose cost the measurement can no longer
// see. That is why the protocol is tab-separated lines in a file, not SafeJSON, and why the
// plan comes in through environment variables rather than a parsed argv.
//
//   GT_TS_PLAN   file with one absolute module path per line, children before parents
//   GT_TS_OUT    file to append results to, one `<index>\t<ms>\t<status>[\t<message>]` line each
//   GT_TS_MODE   "each" (default) imports every plan line in order; "cold" imports only the last
//
// A module that calls process.exit() during import (a CLI entrypoint parsing argv) is reported
// as `exit <code>` instead of killing the run, and the results file is appended line by line so
// a module that never returns still leaves everything before it on disk.

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
process.argv = [process.argv[0], process.argv[1]];

function record(index: number, ms: number, status: string, message?: string): void {
    const tail = message === undefined ? "" : `\t${message.replace(/[\t\n\r]+/g, " ").slice(0, 400)}`;
    appendFileSync(outPath as string, `${index}\t${ms.toFixed(3)}\t${status}${tail}\n`);
}

async function importOne(index: number, file: string): Promise<void> {
    const started = performance.now();

    try {
        await import(file);
        record(index, performance.now() - started, "ok");
    } catch (error) {
        const elapsed = performance.now() - started;

        if (error instanceof ExitDuringImport) {
            record(index, elapsed, "exit", String(error.code));
            return;
        }

        record(index, elapsed, "error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
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
