// Fixture: before console.* codemod sweep
// This file exercises all console.* call patterns the codemod must handle.

function exampleFn(msg: string): void {
    console.log("simple log");
    console.info("info message");
    console.warn("warning message");
    console.error("error message");
    console.debug("debug message");
}

function multiArg(err: Error): void {
    console.error("something went wrong", err);
    console.warn("watch out", "multiple", "args");
    console.log("values:", 1, 2, 3);
}

// console in a nested block
function nested(): void {
    if (true) {
        console.log("nested log");
    }
}

// Template literal args
function withTemplate(name: string): void {
    console.log(`Hello, ${name}`);
}
