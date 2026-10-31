import { codexWorkerRoute, type HarnessAnswer } from "../deliver";

/**
 * Codex answers only through its `tools codex` worker: it is never typed into, so its route answers `none` rather
 * than passing on, and it lists no owned workers (that worker is the route).
 */
export const harnessAnswer: HarnessAnswer = { routes: [codexWorkerRoute], ownedWorkers: () => [] };
