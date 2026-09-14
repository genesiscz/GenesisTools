// RN-safe logger shim. The repo's real `@genesiscz/utils/logger` is pino-backed and opens a
// day-stamped file under `~/.genesis-tools/logs/`, so it pulls `node:fs`/`node:path`/`node:os` in.
// `@dd/contract` value-imports it from exactly one place (`contract/auth-header.ts`, a single
// `logger.warn` on a malformed Basic header), which is enough to drag all of that into the Hermes
// bundle. This shim is aliased in its place for the mobile app, in metro.config.js only. Unlike the
// safe-json shim there is deliberately NO tsconfig `paths` entry: the facade below is a narrower
// type than the real logger, and repo modules that the contract's type-only re-exports pull into
// the mobile typecheck (`utils/table.ts`, `utils/readme.ts`, `utils/cli/executor.ts`) call
// `out.println`, which the facade does not have. They never execute in the bundle, so they should
// keep type-checking against the real module while Metro swaps the runtime one. Server code is
// untouched either way.
//
// The implementation is the repo's OWN browser-safe facade (`src/utils/logger/client.ts`) rather
// than a reimplementation, so behaviour cannot drift. It is reached relatively on purpose: the
// Metro alias table matches `@genesiscz/utils/logger` exactly and has no rule for the nested
// `@genesiscz/utils/logger/client` specifier, so the alias form would not resolve in the bundle.
export { logger, out } from "../../../../src/utils/logger/client";
export type { LoggerFacade, Out } from "../../../../src/utils/logger/client";

/**
 * CLI-only knobs. Repo modules reached through the contract's type-only re-exports import these by
 * name, so the shim has to carry them or those files fail to resolve — the same reason the
 * safe-json shim carries `parseJSON`. They configure a pino transport that does not exist here.
 */
export function setBaseBinding(_bindings: Record<string, unknown>): void {}

export function setConsoleLevel(_level: string): void {}
