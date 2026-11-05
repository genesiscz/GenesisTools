import { basename, join, relative } from "node:path";
import type { E2eProject } from "@genesiscz/utils/e2e/project";

export interface SpecFile {
    /** The file name without its spec suffix: `agents.flow` for `agents.flow.spec.ts`. */
    name: string;
    /** The path relative to the e2e config's folder. */
    path: string;
    /** The absolute path. */
    file: string;
}

export const DEFAULT_SPEC_PATTERN = "**/*.spec.ts";

export function specName(file: string): string {
    return basename(file).replace(/\.(spec|test|e2e)\.[cm]?[jt]sx?$/, "");
}

/** Every spec file under the project's spec folder, sorted by path. */
export function listSpecs(project: E2eProject): SpecFile[] {
    const dir = join(project.dir, project.config.specs.dir);
    const pattern = project.config.specs.pattern ?? DEFAULT_SPEC_PATTERN;
    return [...new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true })].sort().map((file) => {
        const absolute = join(dir, file);
        return { name: specName(file), path: relative(project.dir, absolute), file: absolute };
    });
}

/** The specs named: an exact name or path first, else every spec whose name contains the word. */
export function resolveSpecs(all: SpecFile[], names: string[]): SpecFile[] {
    const picked = names.flatMap((name) => {
        const exact = all.filter((spec) => spec.name === name || spec.path === name);
        const matches = exact.length > 0 ? exact : all.filter((spec) => spec.name.includes(name));

        if (matches.length === 0) {
            throw new Error(`no spec matches "${name}"; specs: ${all.map((spec) => spec.name).join(", ") || "none"}`);
        }

        return matches;
    });
    return [...new Map(picked.map((spec) => [spec.path, spec])).values()];
}

/** A named suite's specs, in the suite's order; `all` is every spec. */
export function suiteSpecs(project: E2eProject, all: SpecFile[], suite: string): SpecFile[] {
    if (suite === "all") {
        return all;
    }

    const suites = project.config.suites ?? {};
    const names = suites[suite];

    if (!names) {
        throw new Error(
            `no suite "${suite}"; suites: all${Object.keys(suites)
                .map((name) => `, ${name}`)
                .join("")}`
        );
    }

    return resolveSpecs(all, names);
}
