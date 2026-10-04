/**
 * Builders for the actions of a declarative component rule (`ComponentRule.do`). Each returns a plain
 * tagged object; a rule runner reads `type` and applies the action.
 */
export const r = {
    // JSX actions
    renameComponent: (to: { name: string; module: string }) => ({ type: "renameComponent" as const, to }),
    setProp: (op: { name: string; value: unknown }) => ({ type: "setProp" as const, ...op }),
    removeProp: (name: string) => ({ type: "removeProp" as const, name }),
    renameProp: (from: string, to: string) => ({ type: "renameProp" as const, from, to }),
    transformProp: (name: string, fn: (v: unknown) => unknown) => ({ type: "transformProp" as const, name, fn }),
    appendAfter: (p: { component: string; props?: Record<string, unknown>; importPath?: string }) => ({
        type: "appendAfter" as const,
        ...p,
    }),
    // nested prop ops
    removeNestedProp: (op: { targetProp: string; name: string }) => ({
        type: "removeNestedProp" as const,
        ...op,
    }),
    renameNestedProp: (op: { targetProp: string; from: string; to: string }) => ({
        type: "renameNestedProp" as const,
        ...op,
    }),
    movePropToNested: (op: { name: string; targetProp: string; nestedProp: string }) => ({
        type: "movePropToNested" as const,
        ...op,
    }),
    addNewProp: (p: { name: string; value: unknown }) => ({ type: "addNewProp" as const, ...p }),
    // non-JSX
    renameIdentifier: (from: { name: string; module?: string }, to: { name: string; module?: string }) => ({
        type: "renameIdentifier" as const,
        from,
        to,
    }),
    renameImport: (
        from: { module: string; importedName: string | string[] },
        to?: { module: string; importedName?: string; localName?: string }
    ) => ({
        type: "renameImport" as const,
        from,
        to,
    }),
    renameModule: (fromModule: string, toModule: string) => ({
        type: "renameModule" as const,
        fromModule,
        toModule,
    }),
    renameEnum: (from: { name: string; module?: string }, to: { name: string; module?: string }) => ({
        type: "renameEnum" as const,
        from,
        to,
    }),
    renameHook: (from: { name: string; module?: string }, to: { name: string; module?: string }) => ({
        type: "renameHook" as const,
        from,
        to,
    }),
    renameType: (from: { name: string; module?: string }, to: { name: string; module?: string }) => ({
        type: "renameType" as const,
        from,
        to,
    }),
    useTransformer: (name: string) => ({ type: "useTransformer" as const, name }),
};
