import { readE2eSpecContext } from "../../../src/utils/e2e/spec-env";

/**
 * The run `tools e2e` started this spec process in: the simulator, its Appium and WebDriverAgent ports, and the spec's
 * run folder and results file. Every field is absent under a plain `bun run e2e`.
 */
export const e2eRun = readE2eSpecContext(process.env);
