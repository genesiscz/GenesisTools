import { SafeJSON } from "@app/utils/json";

export type Fetcher = typeof fetch;

export const MAIN_PKG = "@anthropic-ai/claude-code";
const REGISTRY = "https://registry.npmjs.org";

export interface Packument {
    versions: string[];
    time: Record<string, string>;
}

export interface VersionManifest {
    version: string;
    dist: { tarball: string; integrity?: string };
    optionalDependencies?: Record<string, string>;
}

export function platformPkg(platform: string): string {
    return `${MAIN_PKG}-${platform}`;
}

export function hostPlatform(): string {
    return `${process.platform}-${process.arch}`;
}

function encodePkg(pkg: string): string {
    return pkg.replace("/", "%2f");
}

async function fetchJson({ url, fetcher }: { url: string; fetcher: Fetcher }): Promise<unknown> {
    const res = await fetcher(url);

    if (!res.ok) {
        throw new Error(`registry ${res.status} for ${url}`);
    }

    return SafeJSON.parse(await res.text(), { strict: true });
}

export async function fetchPackument({ pkg, fetcher = fetch }: { pkg: string; fetcher?: Fetcher }): Promise<Packument> {
    const raw = (await fetchJson({ url: `${REGISTRY}/${encodePkg(pkg)}`, fetcher })) as {
        versions: Record<string, unknown>;
        time: Record<string, string>;
    };
    const versions = Object.keys(raw.versions).sort((a, b) => Bun.semver.order(a, b));
    return { versions, time: raw.time ?? {} };
}

export function resolveRange({ all, from, to }: { all: string[]; from: string; to: string }): string[] {
    for (const endpoint of [from, to]) {
        if (!all.includes(endpoint)) {
            throw new Error(`version ${endpoint} was never published (check \`tools claude-code versions\`)`);
        }
    }

    const sorted = [...all].sort((a, b) => Bun.semver.order(a, b));
    const lo = sorted.indexOf(from);
    const hi = sorted.indexOf(to);

    if (lo > hi) {
        throw new Error(`range is inverted: ${from} > ${to}`);
    }

    return sorted.slice(lo, hi + 1);
}

export async function fetchManifest({
    pkg,
    version,
    fetcher = fetch,
}: {
    pkg: string;
    version: string;
    fetcher?: Fetcher;
}): Promise<VersionManifest> {
    return (await fetchJson({ url: `${REGISTRY}/${encodePkg(pkg)}/${version}`, fetcher })) as VersionManifest;
}
