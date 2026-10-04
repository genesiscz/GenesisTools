import type {
    ASTPath,
    Collection,
    FileInfo,
    ImportDeclaration,
    ImportDefaultSpecifier,
    ImportNamespaceSpecifier,
    ImportSpecifier,
    JSCodeshift,
    Program,
} from "jscodeshift";
import { acceptsNamedImports } from "./ast-helpers";
import type { AutoLogger, ImportManager } from "./types";

// -----------------------------------------------------------------------------
// Utilities for import analysis
// -----------------------------------------------------------------------------

type AnyImportSpecifier = ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier;

type ComponentRenameResult = ReturnType<ImportManager["resolveComponentRename"]>;

function isSideEffectImport(node: ImportDeclaration): boolean {
    return (node.specifiers?.length || 0) === 0;
}

function isTypeOnlyImport(node: ImportDeclaration): boolean {
    // the TS parser sets importKind === "type" for `import type { Foo } from "..."`
    return node.importKind === "type";
}

function hasNamespaceSpecifier(node: ImportDeclaration): boolean {
    return (node.specifiers || []).some((s) => s.type === "ImportNamespaceSpecifier");
}

function hasDefaultSpecifier(node: ImportDeclaration): boolean {
    return (node.specifiers || []).some((s) => s.type === "ImportDefaultSpecifier");
}

/** A named specifier's imported name. */
function importedNameOf(s: ImportSpecifier): string | undefined {
    const name = s.imported?.name;
    return typeof name === "string" ? name : undefined;
}

/** A specifier's explicit local name. */
function localOf(s: AnyImportSpecifier): string | undefined {
    const name = s.local?.name;
    return typeof name === "string" ? name : undefined;
}

function getNamedSpecifiers(node: ImportDeclaration): ImportSpecifier[] {
    return (node.specifiers || []).filter((s): s is ImportSpecifier => s.type === "ImportSpecifier");
}

function summarizeImport(node: ImportDeclaration): string {
    const parts: string[] = [];

    if (isSideEffectImport(node)) {
        parts.push("side-effect");
    }

    if (isTypeOnlyImport(node)) {
        parts.push("type");
    }

    if (hasNamespaceSpecifier(node)) {
        parts.push("namespace");
    }

    if (hasDefaultSpecifier(node)) {
        parts.push("default");
    }

    const names = getNamedSpecifiers(node)
        .map((s) => localOf(s) || importedNameOf(s) || "?")
        .join(", ");
    const source = String(node.source.value);
    return `[${parts.join("|")}] ${source}${names ? ` { ${names} }` : ""}`;
}

/** The binding a specifier creates: its local name, else the imported name for a named specifier. */
function localNameOf(s: AnyImportSpecifier): string | undefined {
    return localOf(s) || (s.type === "ImportSpecifier" ? importedNameOf(s) : undefined);
}

/** Every parameter of a function type after the first. */
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : [];

// -----------------------------------------------------------------------------
// AST-backed ImportManager: edits the import declarations in place, with debug logs
// -----------------------------------------------------------------------------

export class ImportManagerImpl {
    constructor(
        private j: JSCodeshift,
        private root: Collection,
        private logger: AutoLogger,
        private fileInfo: FileInfo
    ) {}

    debug(message: string): void {
        this.logger.debug(this.fileInfo.path, message);
    }

    logImportChange(...params: Tail<Parameters<AutoLogger["importChange"]>>): void {
        this.logger.importChange(this.fileInfo.path, ...params);
    }

    /** Logs every import declaration of the file at debug level; changes nothing. */
    scan(): void {
        try {
            const decls = this.root.find(this.j.ImportDeclaration);
            this.debug(`[Imports] scan() found ${decls.length} import declarations`);
            decls.forEach((p) => {
                this.debug(`[Imports] ${summarizeImport(p.node)}`);
            });
        } catch (err) {
            this.debug(`[Imports] scan() diagnostics failed: ${String(err)}`);
        }
    }

    /**
     * Makes `localName` (default: `importedName`) bound to `importedName` from `module`. Merges into an existing
     * plain import of the module when there is one, else adds a declaration after the last import. Then removes
     * any OTHER module's specifier that binds the same local name.
     */
    ensureImport(module: string, importedName: string, localName?: string): { localName: string } {
        const j = this.j;
        const existing = this.root.find(j.ImportDeclaration, { source: { value: module } });
        this.logImportChange(module, importedName, "ensure", localName ? `as ${localName}` : "");
        const targetLocal = localName || importedName;

        const mergeTarget = existing.paths().find((p) => acceptsNamedImports(p.node));

        if (mergeTarget) {
            const node = mergeTarget.node;
            const existingLocals = new Set<string>();

            for (const s of node.specifiers || []) {
                if (s.type === "ImportSpecifier") {
                    const imported = importedNameOf(s);
                    const local = localOf(s) || imported;
                    if (local) {
                        existingLocals.add(local);
                    }
                }
            }

            if (!existingLocals.has(targetLocal)) {
                node.specifiers = node.specifiers || [];
                node.specifiers.push(
                    j.importSpecifier(
                        j.identifier(importedName),
                        targetLocal !== importedName ? j.identifier(targetLocal) : null
                    )
                );
            }

            this.deduplicateLocalAcrossModules(module, targetLocal);
            this.logImportChange(module, importedName, "ensure");
            return { localName: targetLocal };
        }

        const decl = j.importDeclaration(
            [
                j.importSpecifier(
                    j.identifier(importedName),
                    targetLocal !== importedName ? j.identifier(targetLocal) : null
                ),
            ],
            j.literal(module)
        );

        const lastImport = this.root.find(j.ImportDeclaration).at(-1);
        if (lastImport.length > 0) {
            lastImport.insertAfter(decl);
        } else {
            const program: Program = this.root.get().node.program;
            program.body.unshift(decl);
        }

        this.deduplicateLocalAcrossModules(module, targetLocal);
        this.logger.importChange("", module, importedName, "ensure");
        return { localName: targetLocal };
    }

    private deduplicateLocalAcrossModules(preferredModule: string, localName: string): void {
        const j = this.j;
        this.debug(`[Imports] deduplicateLocalAcrossModules prefer=${preferredModule} local=${localName}`);
        this.root.find(j.ImportDeclaration).forEach((path) => {
            const mod = String(path.node.source.value);
            if (mod === preferredModule) {
                return;
            }

            const before = path.node.specifiers?.length || 0;
            // never touch side-effect-only imports (e.g. import "./App.css")
            if (before === 0) {
                return;
            }

            path.node.specifiers = (path.node.specifiers || []).filter((s) => {
                if (s.type === "ImportNamespaceSpecifier") {
                    return true;
                }

                return localNameOf(s) !== localName;
            });

            if ((path.node.specifiers?.length || 0) === 0) {
                j(path).remove();
            } else if ((path.node.specifiers?.length || 0) !== before) {
                this.logger.importChange("", mod, localName, "removed", `deduplicated in favor of ${preferredModule}`);
            }
        });
    }

    /**
     * Removes the specifier of `module` that imports or binds `importedOrLocalName` (`"default"` names the default
     * import). Namespace and side-effect-only imports are kept; a declaration left empty is removed.
     */
    removeImport(module: string, importedOrLocalName: string): void {
        const j = this.j;
        this.debug(`[Imports] removeImport(${module}, ${importedOrLocalName})`);

        this.root.find(j.ImportDeclaration, { source: { value: module } }).forEach((p) => {
            const before = p.node.specifiers?.length || 0;
            if (before === 0) {
                return;
            }

            p.node.specifiers = (p.node.specifiers || []).filter((s) => {
                if (s.type === "ImportSpecifier") {
                    const imported = importedNameOf(s);
                    const local = localOf(s) || imported;
                    return !(imported === importedOrLocalName || local === importedOrLocalName);
                }

                if (s.type === "ImportDefaultSpecifier") {
                    const local = s.local?.name;
                    return !(importedOrLocalName === "default" || local === importedOrLocalName);
                }

                return true;
            });

            if ((p.node.specifiers?.length || 0) === 0) {
                j(p).remove();
            }

            if ((p.node.specifiers?.length || 0) !== before) {
                this.debug(`[Imports] importChange(${module}, ${importedOrLocalName}, "removed")`);
            }
        });
    }

    /** Not implemented: a no-op. */
    aliasLocalName(_local: string, _alias: string): void {}

    /** Not implemented: a no-op. */
    ensureEnumImport(_opts: { name: string; module: string }): void {}

    /** Not implemented: a no-op. */
    ensureTypeImport(_opts: { name: string; module: string }): void {}

    /**
     * Imports `to` for a component rename and returns the name to use in JSX. When the name stays and the module
     * changes, the old import goes. Any other module's import that already binds `to.name` goes too. The old
     * import otherwise stays: other usages of the same component may be renamed to a different target.
     */
    resolveComponentRename(opts: {
        from: { name: string; module?: string };
        to: { name: string; module?: string };
    }): ComponentRenameResult {
        const { from, to } = opts;
        const j = this.j;
        this.debug(`[Imports] resolveComponentRename from=${from.module}:${from.name} -> ${to.module}:${to.name}`);

        if (from.module && to.module) {
            if (from.name === to.name && from.module !== to.module) {
                this.removeImport(from.module, from.name);
                this.debug(
                    `[Imports] Removed conflicting import ${from.name} from ${from.module} (same name, different module)`
                );
            }

            // e.g. Card (old module) -> Panel -> Card (new module): the old Card binding must go
            this.root.find(j.ImportDeclaration).forEach((path) => {
                const moduleSource = String(path.node.source.value);
                if (moduleSource === to.module) {
                    return;
                }

                const hasConflict = (path.node.specifiers || []).some((spec) => {
                    const localName =
                        spec.local?.name || (spec.type === "ImportSpecifier" ? importedNameOf(spec) : undefined);
                    return localName === to.name;
                });

                if (hasConflict) {
                    this.removeImport(moduleSource, to.name);
                    this.debug(
                        `[Imports] Removed conflicting import ${to.name} from ${moduleSource} (name conflict with new import)`
                    );
                }
            });

            const result = this.ensureImport(to.module, to.name, to.name);
            return { useName: result.localName, importActions: [] };
        }

        if (to.module) {
            const result = this.ensureImport(to.module, to.name, to.name);
            return { useName: result.localName, importActions: [] };
        }

        return { useName: to.name, importActions: [] };
    }

    /**
     * Merges several declarations of one module into the first: value imports into one, type-only imports into
     * another. Modules with a namespace import and side-effect-only declarations are left alone; only the first
     * default import survives.
     */
    consolidate(): void {
        const j = this.j;
        this.debug("[Imports] consolidate()");

        const importsByModule = new Map<string, ASTPath<ImportDeclaration>[]>();

        this.root.find(j.ImportDeclaration).forEach((path) => {
            const mod = String(path.node.source.value);
            const list = importsByModule.get(mod);
            if (list) {
                list.push(path);
            } else {
                importsByModule.set(mod, [path]);
            }
        });

        for (const declarations of importsByModule.values()) {
            if (declarations.length <= 1) {
                continue;
            }

            const hasNamespace = declarations.some((p) =>
                (p.node.specifiers || []).some((s) => s.type === "ImportNamespaceSpecifier")
            );
            if (hasNamespace) {
                continue;
            }

            const typeOnlyDecls: ASTPath<ImportDeclaration>[] = [];
            const valueDecls: ASTPath<ImportDeclaration>[] = [];

            for (const p of declarations) {
                if ((p.node.specifiers || []).length === 0) {
                    continue;
                }

                if (p.node.importKind === "type") {
                    typeOnlyDecls.push(p);
                } else {
                    valueDecls.push(p);
                }
            }

            const firstValueDecl = valueDecls[0];
            if (valueDecls.length > 1 && firstValueDecl) {
                const allValueSpecs: AnyImportSpecifier[] = [];
                let defaultSpec: ImportDefaultSpecifier | null = null;

                for (const p of valueDecls) {
                    for (const s of p.node.specifiers || []) {
                        if (s.type === "ImportDefaultSpecifier") {
                            if (!defaultSpec) {
                                defaultSpec = s;
                            }
                        } else {
                            allValueSpecs.push(s);
                        }
                    }
                }

                const finalSpecs = defaultSpec ? [defaultSpec, ...allValueSpecs] : allValueSpecs;
                if (finalSpecs.length > 0) {
                    firstValueDecl.node.specifiers = finalSpecs;

                    for (const p of valueDecls.slice(1)) {
                        j(p).remove();
                    }
                }
            }

            const firstTypeDecl = typeOnlyDecls[0];
            if (typeOnlyDecls.length > 1 && firstTypeDecl) {
                const allTypeSpecs: AnyImportSpecifier[] = typeOnlyDecls.flatMap((p) => p.node.specifiers || []);

                if (allTypeSpecs.length > 0) {
                    firstTypeDecl.node.specifiers = allTypeSpecs;

                    for (const p of typeOnlyDecls.slice(1)) {
                        j(p).remove();
                    }
                }
            }
        }
    }

    /** Finishes the file's imports: consolidates declarations of the same module. */
    applyChanges(): void {
        this.debug("[Imports] applyChanges()");
        this.consolidate();
    }

    /**
     * Moves `from.importedName` of `from.module` (`"default"` for the default import) to `to`, keeping its local
     * name unless `to.localName` says otherwise. Without `to`, the import is only removed.
     */
    resolveImportRename(
        from: { module: string; importedName: string },
        to?: { module: string; importedName?: string; localName?: string }
    ): { localName?: string } {
        const j = this.j;
        const fromModule = from.module;
        const fromImported = from.importedName;
        let resultLocalName: string | undefined;

        this.root.find(j.ImportDeclaration, { source: { value: fromModule } }).forEach((path) => {
            const specs = path.node.specifiers || [];

            for (const s of specs) {
                if (fromImported === "default" && s.type !== "ImportDefaultSpecifier") {
                    continue;
                }

                if (
                    fromImported !== "default" &&
                    (s.type !== "ImportSpecifier" || importedNameOf(s) !== fromImported)
                ) {
                    continue;
                }

                const localName = s.type === "ImportSpecifier" ? localOf(s) || fromImported : localOf(s) || "default";

                this.logger.debug(
                    "",
                    `[Imports] resolveImportRename from=${fromModule}:${fromImported} to=${to?.module ?? "-"}:${
                        to?.importedName ?? "-"
                    } as ${to?.localName ?? "-"}`
                );

                this.removeImport(fromModule, s.type === "ImportDefaultSpecifier" ? "default" : fromImported);

                if (!to) {
                    continue;
                }

                const nextImported = to.importedName || fromImported;
                const desiredLocal = to.localName || (fromImported === "default" ? nextImported : localName);

                const existing = this.root
                    .find(j.ImportDeclaration, { source: { value: to.module } })
                    .filter((p) =>
                        (p.node.specifiers || []).some(
                            (sp) =>
                                sp.type === "ImportSpecifier" && (sp.local?.name || importedNameOf(sp)) === desiredLocal
                        )
                    );

                if (existing.length === 0) {
                    const result = this.ensureImport(to.module, nextImported, desiredLocal);
                    resultLocalName ||= result.localName;
                } else {
                    resultLocalName ||= desiredLocal;
                }

                this.logImportChange(to.module, nextImported, "moved", `from ${fromModule}`);
            }
        });

        return { localName: resultLocalName };
    }

    /** Points every import of `fromModule` at `toModule`. */
    resolveModuleRename(fromModule: string, toModule: string): void {
        const j = this.j;
        this.logger.debug("", `[Imports] resolveModuleRename ${fromModule} -> ${toModule}`);

        this.root.find(j.ImportDeclaration, { source: { value: fromModule } }).forEach((p) => {
            p.node.source = j.literal(toModule);
            this.logger.importChange("", toModule, "module", "moved", `from ${fromModule}`);
        });
    }
}

// -----------------------------------------------------------------------------
// Memory-backed ImportManager (experimental): scan -> mutate memory -> rebuild
// -----------------------------------------------------------------------------

type ImportKind = "value" | "type";
type SpecKind = "named" | "default" | "namespace";

interface ImportSpecMem {
    kind: SpecKind;
    /** "default" for a default import, "*" for a namespace */
    imported: string;
    /** Local binding name (for a namespace: the namespace name) */
    local: string;
}

interface ModuleMem {
    module: string;
    value: ImportSpecMem[];
    type: ImportSpecMem[];
    /** Count of side-effect-only declarations */
    sideEffects: number;
    /** First-seen order index */
    order: number;
}

/**
 * An ImportManager that reads every import into memory on `scan()`, applies changes there, and rebuilds the
 * whole import block on `applyChanges()`. Call `scan()` first: without it the rebuild drops every original import.
 */
export class ImportManagerMemoryImpl implements ImportManager {
    private mem = new Map<string, ModuleMem>();
    private orderCounter = 0;

    constructor(
        private j: JSCodeshift,
        private root: Collection,
        private logger: AutoLogger,
        private fileInfo: FileInfo
    ) {}

    debug(message: string): void {
        this.logger.debug(this.fileInfo.path, message);
    }

    logImportChange(...params: Tail<Parameters<AutoLogger["importChange"]>>): void {
        this.logger.importChange(this.fileInfo.path, ...params);
    }

    scan(): void {
        const j = this.j;
        this.mem.clear();
        this.orderCounter = 0;
        const decls = this.root.find(j.ImportDeclaration);
        this.debug(`[Imports:Mem] scan() decls=${decls.length}`);
        decls.forEach((p) => {
            const node = p.node;
            const mod = String(node.source.value);
            const m = this.ensureModuleMem(mod);
            if (isSideEffectImport(node)) {
                m.sideEffects += 1;
                this.debug(`[Imports:Mem] ${mod} += sideEffect`);
                return;
            }

            const kind: ImportKind = isTypeOnlyImport(node) ? "type" : "value";
            for (const s of node.specifiers || []) {
                if (s.type === "ImportNamespaceSpecifier") {
                    const local = typeof s.local?.name === "string" ? s.local.name : "*";
                    this.debug(`[Imports:Mem] ${mod} add namespace ${local}`);
                    m[kind].push({ kind: "namespace", imported: "*", local });
                } else if (s.type === "ImportDefaultSpecifier") {
                    const local = typeof s.local?.name === "string" ? s.local.name : "default";
                    this.debug(`[Imports:Mem] ${mod} add default ${local}`);
                    m[kind].push({ kind: "default", imported: "default", local });
                } else if (s.type === "ImportSpecifier") {
                    const imported = importedNameOf(s) ?? "";
                    const local = typeof s.local?.name === "string" ? s.local.name : imported;
                    this.debug(`[Imports:Mem] ${mod} add named ${imported} as ${local} (${kind})`);
                    m[kind].push({ kind: "named", imported, local });
                }
            }
        });
    }

    private ensureModuleMem(module: string): ModuleMem {
        let mem = this.mem.get(module);
        if (!mem) {
            mem = { module, value: [], type: [], sideEffects: 0, order: this.orderCounter++ };
            this.mem.set(module, mem);
        }

        return mem;
    }

    private removeFromModule(mod: ModuleMem, importedOrLocal: string): void {
        const before = { v: mod.value.length, t: mod.type.length };
        mod.value = mod.value.filter((s) => !(s.local === importedOrLocal || s.imported === importedOrLocal));
        mod.type = mod.type.filter((s) => !(s.local === importedOrLocal || s.imported === importedOrLocal));
        this.debug(
            `[Imports:Mem] removeFromModule ${mod.module} name=${importedOrLocal} before=${before.v}/${before.t} after=${mod.value.length}/${mod.type.length}`
        );

        if (mod.value.length !== before.v || mod.type.length !== before.t) {
            this.logImportChange(mod.module, importedOrLocal, "removed");
        }
    }

    /** `importedName` "default" adds a default import and "*" a namespace import. */
    ensureImport(module: string, importedName: string, localName?: string): { localName: string } {
        const m = this.ensureModuleMem(module);
        const targetLocal = localName || importedName;
        const exists = m.value.some((s) => s.local === targetLocal && s.imported === (importedName || s.imported));
        if (!exists) {
            if (importedName === "default") {
                m.value.push({ kind: "default", imported: "default", local: targetLocal });
            } else if (importedName === "*") {
                m.value.push({ kind: "namespace", imported: "*", local: targetLocal });
            } else {
                m.value.push({ kind: "named", imported: importedName, local: targetLocal });
            }

            this.logImportChange(module, importedName, "ensure");
            this.debug(`[Imports:Mem] ensureImport ${module} ${importedName} as ${targetLocal}`);
        }

        return { localName: targetLocal };
    }

    removeImport(module: string, importedOrLocalName: string): void {
        const m = this.ensureModuleMem(module);
        this.debug(`[Imports:Mem] removeImport ${module} ${importedOrLocalName}`);
        this.removeFromModule(m, importedOrLocalName);
    }

    /** Not implemented: a no-op. */
    aliasLocalName(_local: string, _alias: string): void {}

    /** Not implemented: a no-op. */
    ensureEnumImport(_opts: { name: string; module: string }): void {}

    ensureTypeImport(opts: { name: string; module: string }): void {
        const m = this.ensureModuleMem(opts.module);
        if (!m.type.some((s) => s.kind === "named" && s.imported === opts.name)) {
            m.type.push({ kind: "named", imported: opts.name, local: opts.name });
            this.logImportChange(opts.module, opts.name, "ensureType");
            this.debug(`[Imports:Mem] ensureTypeImport ${opts.module} { ${opts.name} }`);
        }
    }

    /** Same rules as `ImportManagerImpl.resolveComponentRename`, applied to the in-memory imports. */
    resolveComponentRename(opts: {
        from: { name: string; module?: string };
        to: { name: string; module?: string };
    }): ComponentRenameResult {
        const { from, to } = opts;
        this.debug(`[Imports:Mem] resolveComponentRename from=${from.module}:${from.name} -> ${to.module}:${to.name}`);

        if (from.module && to.module) {
            if (from.name === to.name && from.module !== to.module) {
                const fromMod = this.mem.get(from.module);
                if (fromMod) {
                    this.removeFromModule(fromMod, from.name);
                    this.debug(
                        `[Imports:Mem] Removed conflicting import ${from.name} from ${from.module} (same name, different module)`
                    );
                }
            }

            for (const [modPath, mod] of this.mem.entries()) {
                if (modPath !== to.module && mod.value.some((spec) => spec.local === to.name)) {
                    this.removeFromModule(mod, to.name);
                    this.debug(
                        `[Imports:Mem] Removed conflicting import ${to.name} from ${modPath} (name conflict with new import)`
                    );
                }
            }

            const result = this.ensureImport(to.module, to.name, to.name);
            return { useName: result.localName, importActions: [] };
        }

        if (to.module) {
            const result = this.ensureImport(to.module, to.name, to.name);
            return { useName: result.localName, importActions: [] };
        }

        return { useName: to.name, importActions: [] };
    }

    resolveImportRename(
        from: { module: string; importedName: string },
        to?: { module: string; importedName?: string; localName?: string }
    ): { localName?: string } {
        const fromMod = this.ensureModuleMem(from.module);
        const affectedLocals = fromMod.value
            .filter((s) => s.imported === from.importedName || s.local === from.importedName)
            .map((s) => s.local);

        let resultLocalName: string | undefined;

        if (affectedLocals.length > 0) {
            for (const ln of affectedLocals) {
                this.removeFromModule(fromMod, ln);
            }

            this.debug(
                `[Imports:Mem] resolveImportRename from=${from.module}:${from.importedName} -> ${to?.module ?? "-"}:${
                    to?.importedName ?? "-"
                } affected=[${affectedLocals.join(", ")}]`
            );
        }

        if (to) {
            const nextImported = to.importedName || from.importedName;
            for (const ln of affectedLocals) {
                const targetLocal = to.localName || (from.importedName === "default" ? nextImported : ln);
                const result = this.ensureImport(to.module, nextImported, targetLocal);
                this.logImportChange(to.module, nextImported, "moved", `from ${from.module}`);
                resultLocalName ||= result.localName;
            }
        }

        return { localName: resultLocalName };
    }

    resolveModuleRename(fromModule: string, toModule: string): void {
        if (fromModule === toModule) {
            return;
        }

        const fromMem = this.mem.get(fromModule);
        if (!fromMem) {
            return;
        }

        const toMem = this.ensureModuleMem(toModule);
        this.debug(`[Imports:Mem] resolveModuleRename ${fromModule} -> ${toModule}`);
        toMem.value.push(...fromMem.value);
        toMem.type.push(...fromMem.type);
        toMem.sideEffects += fromMem.sideEffects;
        this.mem.delete(fromModule);
        this.logImportChange(toModule, "module", "moved", `from ${fromModule}`);
    }

    /** Nothing to do: the rebuild in `applyChanges()` already writes one declaration per module and kind. */
    consolidate(): void {}

    private buildImportDecl(kind: ImportKind, mod: ModuleMem): ImportDeclaration | null {
        const j = this.j;
        const specs = mod[kind].filter((s) => s.kind !== "namespace");
        const defaultSpec = specs.find((s) => s.kind === "default");

        const list: AnyImportSpecifier[] = [];
        if (defaultSpec) {
            list.push(j.importDefaultSpecifier(j.identifier(defaultSpec.local)));
        }

        for (const s of specs) {
            if (s.kind === "named") {
                list.push(
                    j.importSpecifier(j.identifier(s.imported), s.local !== s.imported ? j.identifier(s.local) : null)
                );
            }
        }

        if (list.length === 0) {
            // namespaces are emitted as their own declarations by applyChanges
            return null;
        }

        const decl = j.importDeclaration(list, j.literal(mod.module));
        if (kind === "type") {
            decl.importKind = "type";
        }

        return decl;
    }

    /**
     * Replaces the file's import declarations with the in-memory state: side-effect imports at the top (each one
     * unshifted, so they land in reverse first-seen order), then value imports, then type-only imports, each in
     * module first-seen order, with namespace imports as their own declarations.
     */
    applyChanges(): void {
        const j = this.j;
        this.debug("[Imports:Mem] applyChanges()");

        const modules = Array.from(this.mem.values()).sort((a, b) => a.order - b.order);

        this.root.find(j.ImportDeclaration).forEach((p) => {
            j(p).remove();
        });

        const program: Program = this.root.get().node.program;

        for (const m of modules) {
            for (let i = 0; i < m.sideEffects; i++) {
                program.body.unshift(j.importDeclaration([], j.literal(m.module)));
            }
        }

        const pushDecl = (decl: ImportDeclaration | null) => {
            if (!decl) {
                return;
            }

            // after the existing import block: before the first non-import statement, or at the end
            const firstNonImport = program.body.findIndex((n) => n.type !== "ImportDeclaration");
            if (firstNonImport === -1) {
                program.body.push(decl);
            } else {
                program.body.splice(firstNonImport, 0, decl);
            }
        };

        for (const kind of ["value", "type"] as const) {
            for (const m of modules) {
                pushDecl(this.buildImportDecl(kind, m));

                for (const ns of m[kind].filter((s) => s.kind === "namespace")) {
                    const decl = j.importDeclaration(
                        [j.importNamespaceSpecifier(j.identifier(ns.local))],
                        j.literal(m.module)
                    );
                    if (kind === "type") {
                        decl.importKind = "type";
                    }

                    pushDecl(decl);
                }
            }
        }
    }
}
