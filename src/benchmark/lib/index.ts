/**
 * In-process measurement library — `import … from "@app/benchmark/lib"`.
 *
 * These modules measure a PROCESS (idle CPU, spawns, fs calls, event-loop
 * stalls) and store named baselines to diff against. They are what a CPU
 * campaign script uses to record a "before" number and then prove the "after".
 *
 * The hyperfine command runner (`./runner`, `./suites`, `./results`) is NOT
 * re-exported here on purpose: it pulls in clack prompts and a CLI surface that
 * a measurement script has no use for. Import it from `./runner` directly.
 */
export {
    type Baseline,
    type BaselineComparison,
    type BaselineDelta,
    type BaselineDirOption,
    type BaselineMetrics,
    baselinePath,
    compareToBaseline,
    formatComparison,
    readBaseline,
    recordBaseline,
} from "./baseline";
export { type FsCounterResult, withFsCounter } from "./fs-counter";
export { type LoopStallMonitor, type LoopStallReport, monitorLoopStalls } from "./loop-stall";
export {
    countThreads,
    type ProcessSample,
    parseCpuTime,
    parseProcRssBytes,
    parseProcStatCpuMs,
    parseProcThreads,
    sampleProcess,
    sampleSelf,
} from "./process-sample";
export { type SignalOutcome, signalVerified, stillRuns } from "./signal";
export { type SpawnCounterResult, type SpawnRecord, withSpawnCounter } from "./spawn-counter";
