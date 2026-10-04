# `@genesiscz/utils/ts/ast`

Helpers for jscodeshift + recast codemods. A recast reprint keeps the original formatting of every node a
transform does not touch, so the diff a codemod produces stays reviewable. Use this for source rewrites
instead of regex or text replacement.

| File | What it gives you |
|---|---|
| `ast-helpers.ts` | JSX props (find, set, rename, move into a nested object, turn into children), component rename, `transformJSXComponent` (declarative per-element transform), import rewrites (`transformImports`, `addOrUpdateImport`, `moveImports`, `consolidateImportsFromModule`), type renames, `PropValue` read and write, `WarningCollector` |
| `ImportManager.ts` | `ImportManagerImpl` edits import declarations in place; `ImportManagerMemoryImpl` reads them into memory and rebuilds the whole import block |
| `import-conflict-resolver.ts` | `ImportConflictResolver`: what a component rename does when the target name is already imported, given the primary library's module |
| `ComponentNode.ts` | `ComponentNode`: one JSX element as a rule target (rename with imports, props, nested props, sibling insert) |
| `guards.ts` | Node-kind type guards; each one accepts `null` and `undefined` and answers `false` |
| `AutoLogger.ts` | `createAutoLogger()`: records every reported change in memory |
| `recast-options.ts` | `getRecastOptions(config?)`: Prettier-style settings mapped to recast print options |
| `rule-builders.ts`, `types.ts` | `r.*` action builders and the shared shapes (`PropValue`, `TransformContext`, `ComponentRule`, ...) |

## Example

Parse with jscodeshift, then rename `OldCard` from `old-ui` to `Card` from `ui-lib` and rename its `tone`
prop. `transformJSXComponent` renames both tags and the prop. `resolveImportRename` moves the import, and
`applyChanges` merges any duplicate declarations. `toSource(getRecastOptions())` reprints only the changed nodes.

```ts
import jscodeshift from "jscodeshift";
import { createAutoLogger, getRecastOptions, ImportManagerImpl, transformJSXComponent } from "@genesiscz/utils/ts/ast";

const j = jscodeshift.withParser("tsx");
const root = j(source);
const imports = new ImportManagerImpl(j, root, createAutoLogger(), { path: file, source });

root.find(j.JSXElement, { openingElement: { name: { name: "OldCard" } } }).forEach((path) => {
    transformJSXComponent(j, path.node, { renameTo: "Card", renameProps: { tone: "variant" } });
});
imports.resolveImportRename(
    { module: "old-ui", importedName: "OldCard" },
    { module: "ui-lib", importedName: "Card", localName: "Card" }
);
imports.applyChanges();

const output = root.toSource(getRecastOptions());
// import { Card } from "ui-lib";
// export const view = <Card variant="muted">Hi</Card>;
```

## Known behaviour to keep in mind

- `ImportConflictResolver.applyImportChanges()` removes every declaration left without specifiers, and that
  includes side-effect imports such as `import "./styles.css"`.
- `ComponentNode.renameNestedProp` rewrites an identifier or estree `Literal` key only; a `StringLiteral` key
  (the tsx parser's spelling) matches but keeps its name.
- `ImportManagerMemoryImpl.applyChanges()` puts side-effect imports back in reverse first-seen order.
