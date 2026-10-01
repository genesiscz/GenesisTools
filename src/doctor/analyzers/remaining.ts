import type { Analyzer } from "@app/doctor/lib/analyzer";
import { BatteryAnalyzer } from "./battery";
import { BrewAnalyzer } from "./brew";
import { DevCachesAnalyzer } from "./dev-caches";
import { ExtensionsAnalyzer } from "./extensions";
import { NetworkAnalyzer } from "./network";
import { SecurityAnalyzer } from "./security";
import { StartupAnalyzer } from "./startup";
import { SystemCachesAnalyzer } from "./system-caches";

export type AnalyzerConstructor = new () => Analyzer;

export const remainingAnalyzerConstructors: AnalyzerConstructor[] = [
    DevCachesAnalyzer,
    SystemCachesAnalyzer,
    StartupAnalyzer,
    BrewAnalyzer,
    BatteryAnalyzer,
    NetworkAnalyzer,
    SecurityAnalyzer,
    ExtensionsAnalyzer,
];

export function createRemainingAnalyzers(): Analyzer[] {
    return remainingAnalyzerConstructors.map((AnalyzerClass) => new AnalyzerClass());
}
