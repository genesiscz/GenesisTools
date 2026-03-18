import { Storage } from "@app/utils/storage/storage";
import type { BenchmarkSuite } from "@app/benchmark/types";

const storage = new Storage("benchmark");

export const BUILTIN_SUITES: BenchmarkSuite[] = [
    {
        name: "startup",
        builtIn: true,
        commands: [
            { label: "tools --help", cmd: "tools --help" },
            { label: "tools port 99999", cmd: "tools port 99999" },
            { label: "tools notify test", cmd: "tools notify test --sound default" },
        ],
    },
    {
        name: "notify",
        builtIn: true,
        commands: [
            { label: "osascript", cmd: "osascript -e 'display notification \"bench\"'" },
            { label: "terminal-notifier", cmd: "terminal-notifier -message bench -title bench" },
        ],
    },
];

export async function getAllSuites(): Promise<BenchmarkSuite[]> {
    const custom = await storage.getConfig<{ suites: BenchmarkSuite[] }>();
    const customSuites = custom?.suites ?? [];
    return [...BUILTIN_SUITES, ...customSuites];
}

export async function getCustomSuites(): Promise<BenchmarkSuite[]> {
    const custom = await storage.getConfig<{ suites: BenchmarkSuite[] }>();
    return custom?.suites ?? [];
}

export async function saveCustomSuites(suites: BenchmarkSuite[]): Promise<void> {
    await storage.setConfig({ suites });
}

export async function findSuite(name: string): Promise<BenchmarkSuite | undefined> {
    const allSuites = await getAllSuites();
    return allSuites.find((s) => s.name === name);
}
