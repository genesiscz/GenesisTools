import { DiskSpaceAnalyzer } from "@app/doctor/analyzers/disk-space";
import { MemoryAnalyzer } from "@app/doctor/analyzers/memory";
import { ProcessesAnalyzer } from "@app/doctor/analyzers/processes";
import type { Analyzer } from "@app/doctor/lib/analyzer";

export type AnalyzerConstructor = new () => Analyzer;

export const coreAnalyzerConstructors: AnalyzerConstructor[] = [DiskSpaceAnalyzer, MemoryAnalyzer, ProcessesAnalyzer];

export function createCoreAnalyzers(): Analyzer[] {
    return coreAnalyzerConstructors.map((AnalyzerCtor) => new AnalyzerCtor());
}

export { DiskSpaceAnalyzer, MemoryAnalyzer, ProcessesAnalyzer };
