import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Project, ts } from "ts-morph";
import logger from "../logger";
import { loadCache, saveCache } from "./cache";
import { extractExports } from "./exportExtractor";
import { findDeclarationFiles, findPackageJsonAndDir } from "./packageResolver";
import type { ExportInfo, IntrospectOptions } from "./types";
import { filterExports } from "./utils";

const DEFAULT_SEARCH_PATHS = [process.cwd(), dirname(process.cwd())];

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 60000): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([promise, timeout]);
}

export async function introspectPackage(packageName: string, options: IntrospectOptions = {}): Promise<ExportInfo[]> {
    const { searchPaths = [], searchTerm, cache = true, cacheDir = ".ts-morph-cache", limit } = options;

    const allSearchPaths = [...searchPaths, ...DEFAULT_SEARCH_PATHS];

    // Check cache first
    if (cache) {
        const cached = await loadCache(cacheDir, packageName);
        if (cached) {
            logger.info(`Using cached results for ${packageName}`);
            return filterExports(cached, searchTerm, limit);
        }
    }

    try {
        // Find package location
        const packageLocation = await findPackageJsonAndDir(packageName, allSearchPaths);
        if (!packageLocation) {
            throw new Error(`Could not find package '${packageName}' in search paths: ${allSearchPaths.join(", ")}`);
        }

        logger.info(`Found package at: ${packageLocation.packageDir}`);

        // Create ts-morph project
        const project = new Project({
            compilerOptions: {
                allowJs: true,
                declaration: true,
                emitDeclarationOnly: true,
                noEmit: false,
                skipLibCheck: true,
                moduleResolution: ts.ModuleResolutionKind.NodeJs,
                esModuleInterop: true,
                resolveJsonModule: true,
                jsx: ts.JsxEmit.React,
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.CommonJS,
            },
            skipAddingFilesFromTsConfig: true,
            skipFileDependencyResolution: true,
        });

        // Find and add declaration files
        const declarationFiles = await findDeclarationFiles(packageLocation);
        if (declarationFiles.length === 0) {
            throw new Error(`No TypeScript declaration files found for package '${packageName}'`);
        }

        logger.info(`Found ${declarationFiles.length} declaration file(s)`);

        const sourceFiles = declarationFiles.map((file) => {
            logger.info(`Adding declaration file: ${file}`);
            return project.addSourceFileAtPath(file);
        });

        // Extract exports
        const allExports: ExportInfo[] = [];

        for (const sourceFile of sourceFiles) {
            const exports = await withTimeout(
                extractExports(sourceFile),
                30000 // 30s timeout per file
            );
            allExports.push(...exports);
        }

        // Remove duplicates
        const uniqueExports = Array.from(new Map(allExports.map((exp) => [exp.name, exp])).values());

        // Save to cache
        if (cache) {
            await saveCache(cacheDir, packageName, uniqueExports);
        }

        return filterExports(uniqueExports, searchTerm, limit);
    } catch (error) {
        logger.error(`Failed to introspect package '${packageName}': ${error}`);
        throw error;
    }
}

export async function introspectSource(sourceCode: string, options: IntrospectOptions = {}): Promise<ExportInfo[]> {
    const { searchTerm, limit } = options;

    try {
        // Create in-memory project
        const project = new Project({
            compilerOptions: {
                allowJs: true,
                skipLibCheck: true,
                moduleResolution: ts.ModuleResolutionKind.NodeJs,
                esModuleInterop: true,
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.CommonJS,
            },
            useInMemoryFileSystem: true,
        });

        // Add source file
        const sourceFile = project.createSourceFile("temp.ts", sourceCode);

        // Extract exports
        const exports = await withTimeout(
            extractExports(sourceFile),
            30000 // 30s timeout
        );

        return filterExports(exports, searchTerm, limit);
    } catch (error) {
        logger.error(`Failed to introspect source code: ${error}`);
        throw error;
    }
}

export async function introspectProject(
    projectPath: string = process.cwd(),
    options: IntrospectOptions = {}
): Promise<ExportInfo[]> {
    const { searchTerm, cache = true, cacheDir = ".ts-morph-cache", limit } = options;

    // Generate cache key from project path
    const cacheKey = crypto.createHash("md5").update(projectPath).digest("hex");

    // Check cache first
    if (cache) {
        const cached = await loadCache(cacheDir, `project-${cacheKey}`);
        if (cached) {
            logger.info(`Using cached results for project at ${projectPath}`);
            return filterExports(cached, searchTerm, limit);
        }
    }

    try {
        // Find tsconfig.json
        let tsconfigPath = join(projectPath, "tsconfig.json");
        if (!existsSync(tsconfigPath)) {
            // Try parent directory
            const parentPath = dirname(projectPath);
            tsconfigPath = join(parentPath, "tsconfig.json");
            if (!existsSync(tsconfigPath)) {
                throw new Error(`Could not find tsconfig.json in ${projectPath} or its parent directory`);
            }
            projectPath = parentPath;
        }

        logger.info(`Loading project from: ${projectPath}`);
        logger.info(`Using tsconfig: ${tsconfigPath}`);

        // Create project from tsconfig
        const project = new Project({
            tsConfigFilePath: tsconfigPath,
            skipAddingFilesFromTsConfig: false,
        });

        // Get all source files
        const sourceFiles = project.getSourceFiles();
        logger.info(`Found ${sourceFiles.length} source file(s)`);

        // Extract exports from all files
        const allExports: ExportInfo[] = [];

        for (const sourceFile of sourceFiles) {
            try {
                const exports = await withTimeout(
                    extractExports(sourceFile),
                    10000 // 10s timeout per file
                );
                allExports.push(...exports);
            } catch (error) {
                logger.warn(`Failed to extract exports from ${sourceFile.getFilePath()}: ${error}`);
                // Continue with other files
            }
        }

        // Remove duplicates
        const uniqueExports = Array.from(
            new Map(allExports.map((exp) => [`${exp.name}:${exp.typeSignature}`, exp])).values()
        );

        // Save to cache
        if (cache) {
            await saveCache(cacheDir, `project-${cacheKey}`, uniqueExports);
        }

        return filterExports(uniqueExports, searchTerm, limit);
    } catch (error) {
        logger.error(`Failed to introspect project at '${projectPath}': ${error}`);
        throw error;
    }
}
