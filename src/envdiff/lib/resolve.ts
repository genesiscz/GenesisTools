import { join } from "node:path";

export interface ResolveEnvPathsArgs {
    positionals: string[];
    cwd: string;
    actual?: string;
    example?: string;
}

export interface ResolvedEnvPaths {
    actual: string;
    example: string;
}

export function resolveEnvPaths({ positionals, cwd, actual, example }: ResolveEnvPathsArgs): ResolvedEnvPaths {
    if (positionals.length >= 2) {
        return {
            actual: actual ?? positionals[0],
            example: example ?? positionals[1],
        };
    }

    const dir = positionals.length === 1 ? positionals[0] : cwd;
    return {
        actual: actual ?? join(dir, ".env"),
        example: example ?? join(dir, ".env.example"),
    };
}
