import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class OverwriteInputError extends Error {
    constructor(readonly path: string) {
        super(`Refusing to write ${path}: it is an input of this job`);
        this.name = "OverwriteInputError";
    }
}

/** The canonical form of a path that may not exist yet: its nearest existing parent through realpath. */
export function canonicalPath(path: string): string {
    const absolute = resolve(path);

    if (existsSync(absolute)) {
        return realpathSync(absolute);
    }

    const parent = dirname(absolute);

    if (parent === absolute) {
        return absolute;
    }

    return join(canonicalPath(parent), basename(absolute));
}

/** The inputs of a job. A job writes only through `claim`, which refuses a path that is one of them. */
export class InputGuard {
    private readonly inputs = new Set<string>();

    constructor(inputs: readonly string[] = []) {
        for (const input of inputs) {
            this.add(input);
        }
    }

    add(path: string): void {
        this.inputs.add(canonicalPath(path));
    }

    has(path: string): boolean {
        return this.inputs.has(canonicalPath(path));
    }

    /** The absolute path to write, or an OverwriteInputError when it is an input. */
    claim(path: string): string {
        if (this.has(path)) {
            throw new OverwriteInputError(resolve(path));
        }

        return resolve(path);
    }

    list(): string[] {
        return [...this.inputs];
    }
}
