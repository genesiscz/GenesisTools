import type { Command } from "commander";

let current: string | undefined;

/**
 * The subcommand `runTool` is executing, such as `jev listen` or `control fill`. Undefined outside a
 * CLI action (tests, servers built without `runTool`). Shared layers use it as a default label, so
 * the usage ledger can say which feature spent a call without every call site naming itself.
 */
export function currentCommand(): string | undefined {
    return current;
}

/** `tools jev` + `listen` -> `jev listen`. The `tools ` prefix of a root name is dropped. */
export function commandPath(command: Command): string {
    const names: string[] = [];
    for (let node: Command | null = command; node; node = node.parent) {
        names.unshift(node.name());
    }

    return names.join(" ").replace(/^tools\s+/, "");
}

export function setCurrentCommand(command: Command): void {
    current = commandPath(command);
}
