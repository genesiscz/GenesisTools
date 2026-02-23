export interface ExportInfo {
    name: string;
    kind: "function" | "class" | "type" | "const";
    typeSignature: string;
    description: string | null;
}

export interface IntrospectOptions {
    searchPaths?: string[];
    searchTerm?: string;
    cache?: boolean;
    cacheDir?: string;
    limit?: number;
}

export interface PackageLocation {
    packageJsonPath: string;
    packageDir: string;
}

export interface CacheEntry {
    exports: ExportInfo[];
    timestamp: number;
}
