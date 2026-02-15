---
name: genesis-tools:typescript-error-fixer
description: "Fix TypeScript compilation errors and eliminate 'any' types across the codebase. Use when build fails due to type errors, when auditing type safety, or when eliminating 'any' types."
---

# TypeScript Error Fixer

Fix all TypeScript compilation errors systematically using a 4-phase workflow. Zero tolerance for `any` types.

## Phase 1: Discovery

1. Detect the package manager (check for `package-lock.json`, `yarn.lock`, `bun.lockb`, `pnpm-lock.yaml`).
2. Run the TypeScript compiler with a 1-2 minute timeout, redirecting output to a log file:
   ```
   tsgo --noEmit 2>&1 | tee tsc-<YYYY-MM-DD-HHmmss>.log
   ```
   Filter to specific directories: `tsgo --noEmit | rg "src/"`
3. Parse the log: extract every error with its file path, line number, error code, and message.
4. Group errors by file and produce a structured error report.

## Phase 2: Planning

1. **Analyze dependencies** -- fixing a type definition file may resolve cascading errors elsewhere. Identify these first.
2. **Prioritize**: type definition files and core utilities before consumers.
3. **Estimate complexity** per file and plan fix order (dependency roots first, leaves last).

## Phase 3: Subagent Deployment

For each file with errors, deploy a subagent (via the Agent tool):

- **Identifier**: `ts-fix-<filename-without-extension>`
- **Context to provide**:
  - The specific file path and all its errors (line numbers, codes, messages).
  - Relevant project patterns from CLAUDE.md.
  - Related type definitions the file depends on.
- **Subagent instructions**:
  1. Read the file and understand its purpose.
  2. Examine related files and type definitions.
  3. Research the root cause of each error.
  4. Apply proper type fixes (never use `any` -- see rules below).
  5. Verify the fix does not introduce new errors.

## Phase 4: Verification

1. Re-run `tsgo --noEmit` (or filter: `tsgo --noEmit | rg "src/"`).
2. Confirm all original errors are resolved.
3. Confirm no new errors were introduced.
4. Produce a summary report: files changed, errors fixed, types improved.

## Zero Tolerance for `any`

`any` is never an acceptable fix. When you encounter it:

1. **Research the actual type** by examining:
   - Function signatures and return types
   - API response structures
   - Library type definitions (`@types` packages)
   - Runtime data flow and usage patterns
2. **Use proper TypeScript utilities**:
   - `Partial<T>`, `Pick<T, K>`, `Omit<T, K>`, `Record<K, V>`
   - `unknown` with type guards instead of `any`
   - `ReturnType<T>`, `Parameters<T>` for function-derived types
   - Create dedicated type/interface definitions for complex shapes
3. **If `any` is temporarily unavoidable**, add a `// TODO:` comment explaining why and the resolution path. This is the only exception.

## Type Research Tools

**Per-file checking (faster than full recompilation):**
- `tools mcp-tsc <file>` -- persistent LSP server, ~100ms for incremental checks
- `tools mcp-tsc --hover --line N --text symbol file.ts` -- type introspection to find the correct type replacing `any`

**Claude Code LSP operations (built-in):**
- `goToDefinition` -- trace type origins to their source
- `hover` -- get inline type info for any symbol
- `findReferences` -- understand usage patterns across the codebase

Use these when researching actual types to replace `any` instead of guessing.

## Error Handling

- If `tsgo` fails to run, check `tsconfig.json` for config issues first.
- If errors span >100 files, prioritize critical/shared files and process in batches.
- If circular type dependencies exist, identify and document them before fixing.

## Quality Checklist

- [ ] Every type is properly researched, not guessed.
- [ ] Fixes align with project-specific patterns (check CLAUDE.md).
- [ ] Complex type decisions have explanatory comments.
- [ ] Typing patterns are consistent across the codebase.
- [ ] No `any` types remain (or each has a documented TODO with resolution path).
