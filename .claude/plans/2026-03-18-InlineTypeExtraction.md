# Inline Type Extraction Plan

Extract 28 inline type annotations into named interfaces across 13 files.
Branch: `fix/inline-types` (from master, `--no-track`)

## Principles

- **Type placement**: module-internal types at top of same file; shared types in existing `types.ts` files
- **One commit per file** (or per logical group of related files)
- **Verify after each change**: `tsgo --noEmit` scoped to the changed file(s)
- **No functional changes** -- pure type extractions only

---

## Task 1: `src/ask/utils/cli.ts` (3 extractions)

- [ ] Read file, verify findings at lines 160, 245, 265
- [ ] Add at top of file (after imports):
  ```ts
  interface ValidationResult {
      valid: boolean;
      errors: string[];
  }

  interface OutputFormatResult {
      type: OutputFormat;
      filename?: string;
  }
  ```
- [ ] Replace `validateOptions` return type (line 160): `{ valid: boolean; errors: string[] }` -> `ValidationResult`
- [ ] Replace `parseOutputFormat` return type (line 245): `{ type: OutputFormat; filename?: string } | undefined` -> `OutputFormatResult | undefined`
- [ ] Replace `getOutputFormat` return type (line 265): same -> `OutputFormatResult | undefined`
- [ ] Run: `tsgo --noEmit | rg "src/ask/utils/cli"`
- [ ] Commit: `refactor(ask): extract ValidationResult and OutputFormatResult interfaces`

## Task 2: `src/ask/AIChat.ts` (1 extraction)

- [ ] Read file, verify finding at line 244
- [ ] Add at top of file (after imports):
  ```ts
  interface EngineWithRestore {
      engine: ChatEngine;
      restore: () => void;
  }
  ```
- [ ] Replace `_getEngine` return type (line 244): `{ engine: ChatEngine; restore: () => void }` -> `EngineWithRestore`
- [ ] Run: `tsgo --noEmit | rg "src/ask/AIChat"`
- [ ] Commit: `refactor(ask): extract EngineWithRestore interface`

## Task 3: `src/ask/utils/websearch.ts` (1 extraction)

- [ ] Read file, verify finding at line 178
- [ ] Add at top of file (after imports):
  ```ts
  interface WebSearchParams {
      query: string;
      numResults?: number;
      safeSearch?: string;
  }
  ```
- [ ] Replace inline callback parameter type (line 178): `(params: { query: string; numResults?: number; safeSearch?: string })` -> `(params: WebSearchParams)`
- [ ] Run: `tsgo --noEmit | rg "src/ask/utils/websearch"`
- [ ] Commit: `refactor(ask): extract WebSearchParams interface`

## Task 4: `src/ask/providers/ProviderManager.ts` (1 extraction)

- [ ] Read file, verify finding at line 375
- [ ] Add at top of file (after imports):
  ```ts
  interface ModelMetadata {
      id: string;
      description?: string;
  }
  ```
- [ ] Replace `parseCapabilities` parameter type (line 375): `(model: { id: string; description?: string })` -> `(model: ModelMetadata)`
- [ ] Run: `tsgo --noEmit | rg "src/ask/providers/ProviderManager"`
- [ ] Commit: `refactor(ask): extract ModelMetadata interface`

## Task 5: `src/mcp-manager/utils/command.utils.ts` (2 extractions)

- [ ] Read file, verify findings at lines 104 and 121
- [ ] Add at top of file (after imports):
  ```ts
  interface ParsedCommand {
      command: string;
      args: string[];
  }

  interface KeyValuePair {
      key: string;
      value: string;
  }
  ```
- [ ] Replace `parseCommandString` return type (line 104): `{ command: string; args: string[] }` -> `ParsedCommand`
- [ ] Replace `parseSinglePair` return type (line 121): `{ key: string; value: string } | null` -> `KeyValuePair | null`
- [ ] Run: `tsgo --noEmit | rg "src/mcp-manager/utils/command.utils"`
- [ ] Commit: `refactor(mcp-manager): extract ParsedCommand and KeyValuePair interfaces`

## Task 6: `src/mcp-tsc/LspWorker.ts` (2 extractions)

- [ ] Read file, verify findings at lines 278 and 900
- [ ] Add at top of file (after imports):
  ```ts
  interface LspDiagnosticsNotification {
      uri: string;
      diagnostics: LspDiagnostic[];
  }

  interface QueueStats {
      length: number;
      isProcessing: boolean;
  }
  ```
- [ ] Replace diagnostics callback parameter type (line 278): `(params: { uri: string; diagnostics: LspDiagnostic[] })` -> `(params: LspDiagnosticsNotification)`
- [ ] Replace `getQueueStats` return type (line 900): `{ length: number; isProcessing: boolean }` -> `QueueStats`
- [ ] Run: `tsgo --noEmit | rg "src/mcp-tsc/LspWorker"`
- [ ] Commit: `refactor(mcp-tsc): extract LspDiagnosticsNotification and QueueStats interfaces`

## Task 7: `src/github-release-notes/index.ts` (1 extraction)

- [ ] Read file, verify finding at line 127
- [ ] Add at top of file (after imports):
  ```ts
  interface RepoIdentity {
      owner: string;
      repo: string;
  }
  ```
- [ ] Replace `parseRepoArg` return type (line 127): `{ owner: string; repo: string } | null` -> `RepoIdentity | null`
- [ ] Run: `tsgo --noEmit | rg "src/github-release-notes/index"`
- [ ] Commit: `refactor(github-release-notes): extract RepoIdentity interface`

## Task 8: `src/telegram/lib/TGClient.ts` (1 extraction)

- [ ] Read file, verify finding at line 95
- [ ] Add at top of file (after imports):
  ```ts
  interface StopHandle {
      stop: () => void;
  }
  ```
- [ ] Replace `startTypingLoop` return type (line 95): `{ stop: () => void }` -> `StopHandle`
- [ ] Run: `tsgo --noEmit | rg "src/telegram/lib/TGClient"`
- [ ] Commit: `refactor(telegram): extract StopHandle interface`

## Task 9: `src/macos-resources/index.tsx` (4 extractions)

- [ ] Read file, verify findings at lines 150, 176, 185, 207
- [ ] Add at top of file (after imports). Note: these are React component prop types, so use explicit prop interfaces:
  ```ts
  interface MemoizedHeaderProps {
      children: React.ReactNode;
      sortBy: "cpu" | "pid" | "files";
  }

  interface MemoizedCellProps {
      children: React.ReactNode;
      column: number;
  }

  interface MemoizedNotificationsPanelProps {
      notifications: Notification[];
  }

  interface MemoizedCommandPanelProps {
      commandHistory: CommandPerformance[];
  }
  ```
- [ ] Replace `MemoizedHeader` inline props (line 150): `({ children, sortBy }: { children: React.ReactNode; sortBy: "cpu" | "pid" | "files" })` -> `({ children, sortBy }: MemoizedHeaderProps)`
- [ ] Replace `MemoizedCell` inline props (line 176): `({ children, column }: { children: React.ReactNode; column: number })` -> `({ children, column }: MemoizedCellProps)`
- [ ] Replace `MemoizedNotificationsPanel` inline props (line 185): `({ notifications }: { notifications: Notification[] })` -> `({ notifications }: MemoizedNotificationsPanelProps)`
- [ ] Replace `MemoizedCommandPanel` inline props (line 207): `({ commandHistory }: { commandHistory: CommandPerformance[] })` -> `({ commandHistory }: MemoizedCommandPanelProps)`
- [ ] Run: `tsgo --noEmit | rg "src/macos-resources/index"`
- [ ] Commit: `refactor(macos-resources): extract React component prop interfaces`

## Task 10: `src/claude-history-dashboard/src/integrations/tanstack-query/root-provider.tsx` (1 extraction)

- [ ] Read file, verify finding at line 10
- [ ] Add at top of file (after imports):
  ```ts
  interface ProviderProps {
      children: React.ReactNode;
      queryClient: QueryClient;
  }
  ```
- [ ] Replace `Provider` inline props (line 10): `({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient })` -> `({ children, queryClient }: ProviderProps)`
- [ ] Run: `tsgo --noEmit | rg "root-provider"`
- [ ] Commit: `refactor(claude-history-dashboard): extract ProviderProps interface`

## Task 11: `src/markdown-cli/index.ts` (1 extraction)

- [ ] Read file, verify finding at line 22
- [ ] Add at top of file (after imports):
  ```ts
  interface MarkdownCLIOptions {
      watch?: boolean;
      width?: number;
      theme?: string;
      color?: boolean;
  }
  ```
- [ ] Replace `.action()` inline options type (line 22): `(file?: string, opts?: { watch?: boolean; width?: number; theme?: string; color?: boolean })` -> `(file?: string, opts?: MarkdownCLIOptions)`
- [ ] Run: `tsgo --noEmit | rg "src/markdown-cli/index"`
- [ ] Commit: `refactor(markdown-cli): extract MarkdownCLIOptions interface`

## Task 12: `src/azure-devops/commands/timelog/prepare-import.ts` (4 extractions)

- [ ] Read file, verify findings at lines 86, 190, 210, 279
- [ ] Add at top of file (after imports):
  ```ts
  interface TimelogAddOptions {
      from?: string;
      to?: string;
      name?: string;
      entry: string;
  }

  interface TimelogRemoveOptions {
      name: string;
      id: string;
  }

  interface TimelogListOptions {
      name: string;
      format?: string;
  }

  interface TimelogClearOptions {
      name: string;
  }
  ```
- [ ] Replace `handleAdd` parameter type (line 86): `(options: { from?: string; to?: string; name?: string; entry: string })` -> `(options: TimelogAddOptions)`
- [ ] Replace `handleRemove` parameter type (line 190): `(options: { name: string; id: string })` -> `(options: TimelogRemoveOptions)`
- [ ] Replace `handleList` parameter type (line 210): `(options: { name: string; format?: string })` -> `(options: TimelogListOptions)`
- [ ] Replace `handleClear` parameter type (line 279): `(options: { name: string })` -> `(options: TimelogClearOptions)`
- [ ] Run: `tsgo --noEmit | rg "src/azure-devops/commands/timelog/prepare-import"`
- [ ] Commit: `refactor(azure-devops): extract timelog prepare-import option interfaces`

## Task 13: `src/automate/lib/builtins.ts` (3 extractions)

The `{ result: StepResult; jumpTo?: string }` pattern is used by `executeBuiltin` (line 23), `handleIf` (line 43), `handlePrompt` (line 79), `handleShell` (line 111), `step-runner.ts:executeStep` (line 21). The `{ result: StepResult }` subset is used by `handleLog` (line 63), `handleSet` (line 165).

- [ ] Read `src/automate/lib/types.ts`, add to it:
  ```ts
  /** Result from a step handler, with optional jump target for branching */
  interface StepHandlerResult {
      result: StepResult;
      jumpTo?: string;
  }
  ```
  Note: `{ result: StepResult }` is a subset of `StepHandlerResult` (jumpTo is already optional), so all three handler return types can use `StepHandlerResult`.
- [ ] In `src/automate/lib/builtins.ts`:
  - Update import to include `StepHandlerResult`
  - Replace `executeBuiltin` return type (line 23): `Promise<{ result: StepResult; jumpTo?: string }>` -> `Promise<StepHandlerResult>`
  - Replace `handleIf` return type (line 43): `{ result: StepResult; jumpTo?: string }` -> `StepHandlerResult`
  - Replace `handleLog` return type (line 63): `{ result: StepResult }` -> `StepHandlerResult`
  - Replace `handlePrompt` return type (line 79): `Promise<{ result: StepResult }>` -> `Promise<StepHandlerResult>`
  - Replace `handleShell` return type (line 111): `Promise<{ result: StepResult }>` -> `Promise<StepHandlerResult>`
  - Replace `handleSet` return type (line 165): `{ result: StepResult }` -> `StepHandlerResult`
- [ ] In `src/automate/lib/step-runner.ts`:
  - Update import to include `StepHandlerResult`
  - Replace `executeStep` return type (line 21): `Promise<{ result: StepResult; jumpTo?: string }>` -> `Promise<StepHandlerResult>`
- [ ] In `src/automate/lib/engine.ts`:
  - Update import to include `StepHandlerResult` (check if it uses the same pattern)
  - Replace any matching inline types
- [ ] Run: `tsgo --noEmit | rg "src/automate/lib/"`
- [ ] Commit: `refactor(automate): extract StepHandlerResult to shared types`

## Task 14: `src/utils/markdown/index.ts` (1 extraction)

- [ ] Read file, verify finding at line 152
- [ ] Add at top of file (after imports):
  ```ts
  interface ParsedTableTokens {
      data: TableData;
      endIdx: number;
  }
  ```
- [ ] Replace `parseTableTokens` return type (line 152): `{ data: TableData; endIdx: number }` -> `ParsedTableTokens`
- [ ] Run: `tsgo --noEmit | rg "src/utils/markdown/index"`
- [ ] Commit: `refactor(utils): extract ParsedTableTokens interface`

## Task 15: `src/mcp-web-reader/utils/tokens.ts` (1 extraction)

- [ ] Read file, verify finding at line 12
- [ ] Add at top of file (after imports):
  ```ts
  interface TokenLimitResult {
      text: string;
      tokens: number;
      truncated: boolean;
  }
  ```
- [ ] Replace `limitToTokens` return type (line 12): `{ text: string; tokens: number; truncated: boolean }` -> `TokenLimitResult`
- [ ] Run: `tsgo --noEmit | rg "src/mcp-web-reader/utils/tokens"`
- [ ] Commit: `refactor(mcp-web-reader): extract TokenLimitResult interface`

## Task 16: `src/Internal/LoggerLib/Logger.ts` (1 extraction)

- [ ] Read file, verify finding at line 710
- [ ] Add at top of file (after imports) or near the `fileTransport` function:
  ```ts
  interface FileTransportOptions {
      filePath: string;
      append?: boolean;
      encoding?: string;
  }
  ```
- [ ] Replace `fileTransport` parameter type (line 710): `(options: { filePath: string; append?: boolean; encoding?: string })` -> `(options: FileTransportOptions)`
- [ ] Run: `tsgo --noEmit | rg "src/Internal/LoggerLib/Logger"`
- [ ] Commit: `refactor(internal): extract FileTransportOptions interface`

---

## Task 17: Final validation and PR

- [ ] Run full type check: `tsgo --noEmit` (no filter -- whole project)
- [ ] Verify all 28 extractions are done: `git log --oneline fix/inline-types ^master`
- [ ] Push: `git push -u origin fix/inline-types`
- [ ] Create PR to `master`:
  - Title: `refactor: extract 28 inline type annotations into named interfaces`
  - Body: summary of changes by category, link to this plan

---

## File-to-Task Index

| File | Task | Extractions |
|------|------|-------------|
| `src/ask/utils/cli.ts` | 1 | 3 |
| `src/ask/AIChat.ts` | 2 | 1 |
| `src/ask/utils/websearch.ts` | 3 | 1 |
| `src/ask/providers/ProviderManager.ts` | 4 | 1 |
| `src/mcp-manager/utils/command.utils.ts` | 5 | 2 |
| `src/mcp-tsc/LspWorker.ts` | 6 | 2 |
| `src/github-release-notes/index.ts` | 7 | 1 |
| `src/telegram/lib/TGClient.ts` | 8 | 1 |
| `src/macos-resources/index.tsx` | 9 | 4 |
| `src/claude-history-dashboard/.../root-provider.tsx` | 10 | 1 |
| `src/markdown-cli/index.ts` | 11 | 1 |
| `src/azure-devops/commands/timelog/prepare-import.ts` | 12 | 4 |
| `src/automate/lib/builtins.ts` + `types.ts` + `step-runner.ts` + `engine.ts` | 13 | 3 |
| `src/utils/markdown/index.ts` | 14 | 1 |
| `src/mcp-web-reader/utils/tokens.ts` | 15 | 1 |
| `src/Internal/LoggerLib/Logger.ts` | 16 | 1 |
| **Total** | | **28** |
