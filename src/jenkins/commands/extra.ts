import type { Command } from "commander";

/** A deployment that ships its own copy of this file registers its own commands here. */
export function registerExtraCommands(_jenkins: Command): void {}
