import { codexWorkerRoute, type HarnessAnswer, t3ThreadRoute } from "../deliver";

/**
 * Codex answers through the T3 Code thread that runs it, else its `tools codex` worker: it is never typed into, so the
 * worker route answers `none` rather than passing on, and it lists no owned workers (that worker is the route).
 */
export const harnessAnswer: HarnessAnswer = { routes: [t3ThreadRoute, codexWorkerRoute], ownedWorkers: () => [] };
