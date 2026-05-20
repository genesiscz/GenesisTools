import { logger, out } from "@app/logger";

// Fixture: before console.* codemod sweep
// This file exercises all console.* call patterns the codemod must handle.

function exampleFn(msg: string): void {
    out.print("simple log");
    out.info("info message");
    out.warn("warning message");
    out.error("error message");
    logger.debug("debug message");
}

function multiArg(err: Error): void {
    out.error("something went wrong", err);
    out.warn("watch out", "multiple", "args");
    out.print("values:", 1, 2, 3);
}

// console in a nested block
function nested(): void {
    if (true) {
        out.print("nested log");
    }
}

// Template literal args
function withTemplate(name: string): void {
    out.print(`Hello, ${name}`);
}
