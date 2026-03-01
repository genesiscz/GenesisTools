import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import logger from "../logger";
import type { PackageLocation } from "./types";

export async function findPackageJsonAndDir(
    packageName: string,
    searchPaths: string[]
): Promise<PackageLocation | null> {
    logger.info(`Searching for package '${packageName}' in paths: ${searchPaths.join(", ")}`);

    // Try multiple strategies to find the package

    // Strategy 1: Try require.resolve (fastest)
    try {
        const resolvedPath = require.resolve(packageName, { paths: searchPaths });
        const packageDir = findPackageRoot(dirname(resolvedPath));
        if (packageDir) {
            const packageJsonPath = join(packageDir, "package.json");
            if (existsSync(packageJsonPath)) {
                logger.info(`Found package via require.resolve at: ${packageDir}`);
                return { packageJsonPath, packageDir };
            }
        }
    } catch (error) {
        logger.info(`require.resolve failed for ${packageName}: ${error}`);
    }

    // Strategy 2: Check standard node_modules paths
    for (const searchPath of searchPaths) {
        const nodeModulesPath = join(searchPath, "node_modules", packageName);
        const packageJsonPath = join(nodeModulesPath, "package.json");

        if (existsSync(packageJsonPath)) {
            logger.info(`Found package in node_modules at: ${nodeModulesPath}`);
            return { packageJsonPath, packageDir: nodeModulesPath };
        }
    }

    // Strategy 3: Check pnpm paths (.pnpm directory)
    for (const searchPath of searchPaths) {
        const pnpmPath = join(searchPath, "node_modules", ".pnpm");
        if (existsSync(pnpmPath)) {
            try {
                const entries = await readdir(pnpmPath);
                for (const entry of entries) {
                    if (entry.includes(packageName)) {
                        const packagePath = join(pnpmPath, entry, "node_modules", packageName);
                        const packageJsonPath = join(packagePath, "package.json");

                        if (existsSync(packageJsonPath)) {
                            // Resolve symlinks for pnpm
                            const realPackagePath = realpathSync(packagePath);
                            logger.info(`Found package in pnpm at: ${realPackagePath}`);
                            return {
                                packageJsonPath: join(realPackagePath, "package.json"),
                                packageDir: realPackagePath,
                            };
                        }
                    }
                }
            } catch (error) {
                logger.warn(`Failed to read pnpm directory: ${error}`);
            }
        }
    }

    // Strategy 4: Check if searchPath is the package itself
    for (const searchPath of searchPaths) {
        const packageJsonPath = join(searchPath, "package.json");
        if (existsSync(packageJsonPath)) {
            try {
                const packageJson = await Bun.file(packageJsonPath).json();
                if (packageJson.name === packageName) {
                    logger.info(`Found package at search path: ${searchPath}`);
                    return { packageJsonPath, packageDir: searchPath };
                }
            } catch (error) {
                logger.warn(`Failed to read package.json at ${packageJsonPath}: ${error}`);
            }
        }
    }

    return null;
}

function findPackageRoot(startPath: string): string | null {
    let currentPath = startPath;

    while (currentPath !== dirname(currentPath)) {
        if (existsSync(join(currentPath, "package.json"))) {
            return currentPath;
        }
        currentPath = dirname(currentPath);
    }

    return null;
}

export async function findDeclarationFiles(packageLocation: PackageLocation): Promise<string[]> {
    const { packageJsonPath, packageDir } = packageLocation;
    const declarationFiles: string[] = [];

    try {
        const packageJson = await Bun.file(packageJsonPath).json();

        // Check for explicit types/typings field
        const typesField = packageJson.types || packageJson.typings;
        if (typesField) {
            const typesPath = join(packageDir, typesField);
            if (existsSync(typesPath)) {
                logger.info(`Found types field pointing to: ${typesPath}`);
                declarationFiles.push(typesPath);
                return declarationFiles;
            }
        }

        // Check exports field
        if (packageJson.exports) {
            const typesPaths = extractTypesFromExports(packageJson.exports, packageDir);
            if (typesPaths.length > 0) {
                logger.info(`Found types in exports field: ${typesPaths.join(", ")}`);
                return typesPaths;
            }
        }

        // Check for index.d.ts
        const indexDts = join(packageDir, "index.d.ts");
        if (existsSync(indexDts)) {
            logger.info(`Found index.d.ts at: ${indexDts}`);
            declarationFiles.push(indexDts);
            return declarationFiles;
        }

        // Check for main field with .d.ts extension
        if (packageJson.main) {
            const mainBase = packageJson.main.replace(/\.[^.]+$/, "");
            const mainDts = join(packageDir, `${mainBase}.d.ts`);
            if (existsSync(mainDts)) {
                logger.info(`Found declaration file for main: ${mainDts}`);
                declarationFiles.push(mainDts);
                return declarationFiles;
            }
        }

        // Fall back to scanning for all .d.ts files
        logger.info(`Scanning for all .d.ts files in ${packageDir}`);
        const allDtsFiles = await findAllDeclarationFiles(packageDir);
        return allDtsFiles;
    } catch (error) {
        logger.error(`Failed to find declaration files: ${error}`);
        return [];
    }
}

function extractTypesFromExports(exports: Record<string, unknown>, packageDir: string): string[] {
    const typesPaths: string[] = [];

    function processExport(exp: unknown) {
        if (typeof exp === "string") {
            if (exp.endsWith(".d.ts")) {
                const fullPath = join(packageDir, exp);
                if (existsSync(fullPath)) {
                    typesPaths.push(fullPath);
                }
            }
        } else if (typeof exp === "object" && exp !== null) {
            const obj = exp as Record<string, unknown>;
            if (typeof obj.types === "string") {
                const fullPath = join(packageDir, obj.types);
                if (existsSync(fullPath)) {
                    typesPaths.push(fullPath);
                }
            }
            // Recursively check nested exports
            for (const value of Object.values(obj)) {
                processExport(value);
            }
        }
    }

    processExport(exports);
    return [...new Set(typesPaths)]; // Remove duplicates
}

async function findAllDeclarationFiles(dir: string, maxDepth: number = 3): Promise<string[]> {
    const declarationFiles: string[] = [];

    async function scan(currentDir: string, depth: number) {
        if (depth > maxDepth) {
            return;
        }

        try {
            const entries = await readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(currentDir, entry.name);

                if (entry.isFile() && entry.name.endsWith(".d.ts")) {
                    declarationFiles.push(fullPath);
                } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
                    await scan(fullPath, depth + 1);
                }
            }
        } catch (error) {
            logger.warn(`Failed to scan directory ${currentDir}: ${error}`);
        }
    }

    await scan(dir, 0);
    return declarationFiles;
}
