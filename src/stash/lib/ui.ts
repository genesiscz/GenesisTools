/**
 * Compat shim — `lib/ui.ts` was promoted to `@app/utils/cli/ui` in v1.1 (see spec §13).
 * In-tree stash files keep this import path; new tools should import from `@app/utils/cli/ui`.
 */
export { ui } from "@app/utils/cli/ui";
