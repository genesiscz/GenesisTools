import { createCoreAnalyzers } from "@app/doctor/analyzers/core";
import { createRemainingAnalyzers } from "@app/doctor/analyzers/remaining";
import type { Analyzer } from "@app/doctor/lib/analyzer";

export function createDoctorAnalyzers(): Analyzer[] {
    return [...createCoreAnalyzers(), ...createRemainingAnalyzers()];
}

export { createCoreAnalyzers } from "@app/doctor/analyzers/core";
export { createRemainingAnalyzers } from "@app/doctor/analyzers/remaining";
