export type BuildStatus = "SUCCESS" | "FAILURE" | "ABORTED" | "UNSTABLE" | "NOT_BUILT";

/** A deployment's own job category, such as "web" or "deploy". "unknown" when no rule matches. */
export type JobType = string;

export interface BuildResult {
    status: BuildStatus;
    duration: number;
    building: boolean;
    number?: number;
}

export interface PipelineResult {
    master: BuildResult;
    downstream: Array<{ jobName: string; buildNumber: number; result: BuildResult }>;
    /** Configured downstream jobs whose build was never found; any of them makes `allPassed` false. */
    missing: string[];
    allPassed: boolean;
}

export interface JobDefinition {
    name: string;
    path: string;
    type: JobType;
    automatic: boolean;
    byTag: boolean;
    description?: string;
}

export interface PipelineRules {
    /** Job names whose builds trigger downstream builds. */
    masters: string[];
    /** Master job name to the job paths it triggers. */
    downstream: Record<string, string[]>;
    /** First rule whose substring occurs in the job name decides the job type. */
    typeHints: Array<{ type: JobType; match: string[] }>;
}

export interface AnalysisResult {
    jobPath: string;
    buildNumber?: number;
    jobName: string;
    buildStatus?: BuildStatus;
    isBuilding?: boolean;
    jobType: JobType;
    suggestedActions: SuggestedAction[];
    context: string;
    timestamp?: number;
    estimatedDuration?: number;
}

export interface SuggestedAction {
    id: string;
    command: string;
    description: string;
    priority: number;
    reason: string;
}

export interface JenkinsBuild {
    number: number;
    result?: BuildStatus;
    building: boolean;
    duration: number;
    timestamp: number;
    estimatedDuration?: number;
}
