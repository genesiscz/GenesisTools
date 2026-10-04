import type { Collection, JSCodeshift } from "jscodeshift";
import { acceptsNamedImports, renameModuleBinding } from "./ast-helpers";

export interface ImportInfo {
    module: string;
    localName: string;
    importedName: string;
    isDefault: boolean;
    isNamespace?: boolean;
    /** Not from the primary library */
    isInternal?: boolean;
    /** `import type {...}` */
    isTypeImport?: boolean;
}

export interface ComponentResolution {
    /** The name to use in JSX */
    useName: string;
    importAction: "none" | "add" | "alias" | "remove";
    importDetails?: {
        module: string;
        importedName: string;
        localName: string;
    };
}

/** The import rewrites of a migration; a renamed import with a `toModule` tells the resolver where the new name lives. */
export interface ImportConflictMigrationConfig {
    imports?: Array<{
        namedImports?: Record<string, { rename?: string; toModule?: string; remove?: boolean }>;
        fromModule?: string;
    }>;
    modules?: Record<string, string>;
}

export interface ImportConflictResolverOptions {
    /** The library a migration moves components to; the default destination of every rename. */
    primaryModule: string;
    /** Other specifiers that count as the primary library, e.g. a local shim that re-exports it. */
    equivalentModules?: string[];
    /** Prefix for a clashing non-primary import, so `Button` from the app becomes `LocalButton`. Default `"Local"`. */
    internalAliasPrefix?: string;
    /** Suffix for the last-resort alias of a primary import, `ButtonLib`. Default `"Lib"`. */
    primaryAliasSuffix?: string;
}

/**
 * Decides what a component rename does to the file's imports when the target name may already be bound. Prefers
 * the primary library's import; when an app-local import clashes with it, the local one gets an alias.
 * Resolutions are tracked with `trackResolution()` and written by `applyImportChanges()`.
 */
export class ImportConflictResolver {
    private primaryModule: string;
    private primaryModules: Set<string>;
    private internalAliasPrefix: string;
    private primaryAliasSuffix: string;

    // renamed component -> the module its new name lives in, from the migration config
    private renameTargetModuleByComponent = new Map<string, string>();

    private importMap = new Map<string, ImportInfo>();

    private pendingAdds = new Map<string, ImportInfo>();
    private pendingRemoves = new Set<string>();
    private pendingAliases = new Map<string, string>();

    constructor(
        private j: JSCodeshift,
        private root: Collection,
        migrationConfig: ImportConflictMigrationConfig | undefined,
        options: ImportConflictResolverOptions
    ) {
        this.primaryModule = options.primaryModule;
        this.primaryModules = new Set([options.primaryModule, ...(options.equivalentModules ?? [])]);
        this.internalAliasPrefix = options.internalAliasPrefix ?? "Local";
        this.primaryAliasSuffix = options.primaryAliasSuffix ?? "Lib";

        this.scanExistingImports();

        for (const imp of migrationConfig?.imports ?? []) {
            for (const [importName, cfg] of Object.entries(imp?.namedImports ?? {})) {
                if (cfg?.rename && cfg?.toModule) {
                    this.renameTargetModuleByComponent.set(importName, cfg.toModule);
                }
            }
        }
    }

    private scanExistingImports(): void {
        this.root.find(this.j.ImportDeclaration).forEach((path) => {
            const source = String(path.node.source.value);
            // type imports never back a component usage
            if (path.node.importKind === "type") {
                return;
            }

            for (const spec of path.node.specifiers || []) {
                if (spec.type === "ImportSpecifier") {
                    const imported = spec.imported.type === "Identifier" ? spec.imported.name : "";
                    const local = typeof spec.local?.name === "string" ? spec.local.name : imported;

                    this.importMap.set(local, {
                        module: source,
                        localName: local,
                        importedName: imported,
                        isDefault: false,
                        isInternal: !this.isPrimaryModule(source),
                        isTypeImport: false,
                    });
                } else if (spec.type === "ImportDefaultSpecifier") {
                    const local = typeof spec.local?.name === "string" ? spec.local.name : "default";

                    this.importMap.set(local, {
                        module: source,
                        localName: local,
                        importedName: "default",
                        isDefault: true,
                        isInternal: !this.isPrimaryModule(source),
                        isTypeImport: false,
                    });
                } else if (spec.type === "ImportNamespaceSpecifier") {
                    const local = typeof spec.local?.name === "string" ? spec.local.name : "*";

                    this.importMap.set(local, {
                        module: source,
                        localName: local,
                        importedName: "*",
                        isDefault: false,
                        isNamespace: true,
                        isInternal: !this.isPrimaryModule(source),
                        isTypeImport: false,
                    });
                }
            }
        });
    }

    private isPrimaryModule(module: string): boolean {
        return this.primaryModules.has(module);
    }

    /**
     * Resolves a component rename using the migration config's target module when it names one, else the
     * primary module. Example: OldHeader -> PageHeader imports PageHeader and drops OldHeader.
     */
    fixComponentRename(originalName: string, targetName: string): ComponentResolution {
        const from = this.importMap.get(originalName)?.module || this.primaryModule;
        const desired = this.renameTargetModuleByComponent.get(originalName) || this.primaryModule;
        return this.resolveComponentUsage(originalName, targetName, from, desired);
    }

    resolveComponentUsage(
        originalName: string,
        targetName: string,
        fromModule: string,
        desiredModule: string = this.primaryModule
    ): ComponentResolution {
        const isRename = originalName !== targetName;

        // 1. the target is already imported from the desired module
        const existingImport = this.importMap.get(targetName);
        if (existingImport && existingImport.module === desiredModule) {
            if (isRename && fromModule === desiredModule) {
                this.pendingRemoves.add(originalName);
            }

            return {
                useName: targetName,
                importAction: "none",
            };
        }

        // 2. the target name is bound to something else
        if (existingImport) {
            return this.resolveConflict(originalName, targetName, fromModule, desiredModule, existingImport);
        }

        // 3. no conflict: add the new import, drop the old one when renaming within the module
        if (isRename && fromModule === desiredModule) {
            this.pendingRemoves.add(originalName);
        }

        return {
            useName: targetName,
            importAction: "add",
            importDetails: {
                module: desiredModule,
                importedName: targetName,
                localName: targetName,
            },
        };
    }

    private resolveConflict(
        originalName: string,
        targetName: string,
        fromModule: string,
        desiredModule: string,
        existingImport: ImportInfo
    ): ComponentResolution {
        const isRename = originalName !== targetName;

        if (existingImport.isDefault) {
            return this.handleDefaultImportConflict(existingImport, targetName, desiredModule);
        }

        // Priority 1: both from the primary library - use the existing import
        if (this.isPrimaryModule(fromModule) && this.isPrimaryModule(existingImport.module)) {
            if (isRename) {
                this.pendingRemoves.add(originalName);
            }

            return {
                useName: targetName,
                importAction: "remove",
                importDetails: {
                    module: fromModule,
                    importedName: originalName,
                    localName: originalName,
                },
            };
        }

        // Priority 2: the existing import is app-local - alias it and import the target
        if (!this.isPrimaryModule(existingImport.module)) {
            this.pendingAliases.set(existingImport.localName, `${this.internalAliasPrefix}${existingImport.localName}`);

            if (isRename && fromModule === desiredModule) {
                this.pendingRemoves.add(originalName);
            }

            return {
                useName: targetName,
                importAction: "add",
                importDetails: {
                    module: desiredModule,
                    importedName: targetName,
                    localName: targetName,
                },
            };
        }

        // the new import would be app-local - alias it
        if (!this.isPrimaryModule(desiredModule)) {
            const internalAlias = `${this.internalAliasPrefix}${targetName}`;

            if (isRename && fromModule === desiredModule) {
                this.pendingRemoves.add(originalName);
            }

            return {
                useName: internalAlias,
                importAction: "alias",
                importDetails: {
                    module: desiredModule,
                    importedName: targetName,
                    localName: internalAlias,
                },
            };
        }

        // Priority 3: last resort - suffix the primary import
        const primaryAlias = `${targetName}${this.primaryAliasSuffix}`;
        return {
            useName: primaryAlias,
            importAction: "alias",
            importDetails: {
                module: desiredModule,
                importedName: targetName,
                localName: primaryAlias,
            },
        };
    }

    private handleDefaultImportConflict(
        existingImport: ImportInfo,
        targetName: string,
        desiredModule: string
    ): ComponentResolution {
        // a default import of the same name is dropped; the target comes in as a named import
        if (existingImport.isDefault) {
            this.pendingRemoves.add(existingImport.localName);

            return {
                useName: targetName,
                importAction: "add",
                importDetails: {
                    module: desiredModule,
                    importedName: targetName,
                    localName: targetName,
                },
            };
        }

        return {
            useName: targetName,
            importAction: "none",
        };
    }

    /** Queues a resolution for `applyImportChanges()`. */
    trackResolution(resolution: ComponentResolution): void {
        if ((resolution.importAction === "add" || resolution.importAction === "alias") && resolution.importDetails) {
            this.pendingAdds.set(resolution.importDetails.localName, {
                module: resolution.importDetails.module,
                localName: resolution.importDetails.localName,
                importedName: resolution.importDetails.importedName,
                isDefault: false,
                isInternal: !this.isPrimaryModule(resolution.importDetails.module),
            });
        } else if (resolution.importAction === "remove" && resolution.importDetails) {
            this.pendingRemoves.add(resolution.importDetails.localName);
        }
    }

    /**
     * Writes the queued changes: renames aliased imports and every reference to them, removes queued specifiers (and a
     * declaration whose last specifier that removed; a side-effect-only import stays), then adds the new imports.
     */
    applyImportChanges(): void {
        const importsByModule = new Map<string, Set<{ imported: string; local: string }>>();

        this.pendingAdds.forEach((info) => {
            let moduleImports = importsByModule.get(info.module);
            if (!moduleImports) {
                moduleImports = new Set();
                importsByModule.set(info.module, moduleImports);
            }

            moduleImports.add({
                imported: info.importedName,
                local: info.localName,
            });
        });

        this.pendingAliases.forEach((newName, oldName) => {
            renameModuleBinding(this.j, this.root, oldName, newName);

            this.root.find(this.j.ImportDeclaration).forEach((path) => {
                // a fresh specifier, not a new `local` on the old one: recast patches a shorthand `{ Button }`'s
                // local in place, and imported and local share that text, so `{ LocalButton }` would come out
                path.node.specifiers = (path.node.specifiers || []).map((spec) => {
                    if (spec.local?.name !== oldName) {
                        return spec;
                    }

                    if (spec.type === "ImportSpecifier") {
                        return this.j.importSpecifier(spec.imported, this.j.identifier(newName));
                    }

                    return spec.type === "ImportDefaultSpecifier"
                        ? this.j.importDefaultSpecifier(this.j.identifier(newName))
                        : this.j.importNamespaceSpecifier(this.j.identifier(newName));
                });
            });
        });

        this.pendingRemoves.forEach((name) => {
            this.root.find(this.j.ImportDeclaration).forEach((path) => {
                // a side-effect-only import (`import "./styles.css"`) binds nothing, so no removal can concern it
                if ((path.node.specifiers?.length ?? 0) === 0) {
                    return;
                }

                path.node.specifiers = (path.node.specifiers || []).filter((spec) => {
                    if (spec.type === "ImportSpecifier") {
                        return !spec.local || spec.local.name !== name;
                    }

                    if (spec.type === "ImportDefaultSpecifier") {
                        return Boolean(spec.local) && spec.local?.name !== name;
                    }

                    return true;
                });

                if (path.node.specifiers?.length === 0) {
                    this.j(path).remove();
                }
            });
        });

        importsByModule.forEach((imports, module) => {
            const declarations = this.root.find(this.j.ImportDeclaration, { source: { value: module } }).paths();
            const alreadyImported = new Set(
                declarations
                    .filter((path) => path.node.importKind !== "type")
                    .flatMap((path) =>
                        (path.node.specifiers || []).flatMap((s) =>
                            s.type === "ImportSpecifier" && s.imported.type === "Identifier" ? [s.imported.name] : []
                        )
                    )
            );
            const specs = Array.from(imports)
                .filter(({ imported }) => !alreadyImported.has(imported))
                .map(({ imported, local }) =>
                    this.j.importSpecifier(
                        this.j.identifier(imported),
                        local !== imported ? this.j.identifier(local) : null
                    )
                );

            if (specs.length === 0) {
                return;
            }

            // one plain value import takes them: under `import type` they would bind no runtime value, and a
            // namespace import cannot carry named specifiers at all
            const target = declarations.find((path) => acceptsNamedImports(path.node));
            if (target) {
                target.node.specifiers = [...(target.node.specifiers || []), ...specs];
                return;
            }

            const newImport = this.j.importDeclaration(specs, this.j.literal(module));

            const lastImport = this.root.find(this.j.ImportDeclaration).at(-1);
            if (lastImport.length > 0) {
                lastImport.insertAfter(newImport);
            } else {
                const firstNode = this.root.find(this.j.Program).get("body", 0);
                if (firstNode) {
                    this.j(firstNode).insertBefore(newImport);
                }
            }
        });
    }

    /** A copy of every value import the resolver saw, keyed by local name. */
    getImportMap(): Map<string, ImportInfo> {
        return new Map(this.importMap);
    }

    /** True when no value import binds `name`. */
    isNameAvailable(name: string): boolean {
        return !this.importMap.has(name);
    }
}
