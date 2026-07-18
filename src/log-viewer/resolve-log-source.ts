import { DebuggingMasterLogSource } from "./debugging-master-log-source";
import type { LogSource, LogSourceId } from "./log-source";
import { TaskLogSource } from "./task-log-source";

const sources: Record<LogSourceId, LogSource> = {
    "debugging-master": new DebuggingMasterLogSource(),
    task: new TaskLogSource(),
};

export function getLogSource(id: LogSourceId): LogSource {
    return sources[id];
}

export function getAllLogSources(): LogSource[] {
    return Object.values(sources);
}
