import type { JobDefinition, PipelineRules } from "./types";

/**
 * Values a deployment may replace by shipping its own copy of this file: its known jobs, the display
 * names an orchestrator prints for its sub-jobs, and which jobs trigger which. Empty here on purpose.
 */
export const JOB_CATALOG: JobDefinition[] = [];

export const SUB_JOB_BY_DISPLAY: Record<string, string> = {};

export const PIPELINE_RULES: PipelineRules = { masters: [], downstream: {}, typeHints: [] };
