# Rename Plugin Prefix `genesis-tools:` → `gt:` + Expand README Plugin Docs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Shorten all skill/command prefixes from `genesis-tools:` to `gt:` and expand the README's Claude Code Plugin section to document all 14 skills and 5 commands with individual sub-sections.

**Architecture:** Two independent workstreams — (1) mechanical find-replace of the prefix, (2) README expansion. Both are string-level changes, no logic changes.

**Tech Stack:** Edit tool, git

---

## Commit 1: Rename `genesis-tools:` → `gt:` everywhere

### Files to modify (21 files)

**Skills — frontmatter `name:` + inline references:**

| File | Occurrences | Notes |
|------|-------------|-------|
| `plugins/genesis-tools/skills/analyze-har/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/automate/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/azure-devops/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/claude-history/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/codebase-analysis/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/git-rebaser/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/github/SKILL.md` | 5 | `name:` + 4 inline refs to `genesis-tools:github-pr` |
| `plugins/genesis-tools/skills/living-docs/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/react-compiler-debug/SKILL.md` | 2 | `name:` + 1 inline ref to `genesis-tools:setup` |
| `plugins/genesis-tools/skills/summarize/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/timelog/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/typescript-error-fixer/SKILL.md` | 1 | `name:` only |
| `plugins/genesis-tools/skills/writing-plans/SKILL.md` | 1 | `name:` only |

Note: `debugging-master/SKILL.md` has NO `genesis-tools:` prefix — its name is just `debugging-master`. Skip it.

**Commands — frontmatter `name:` + inline references:**

| File | Occurrences | Notes |
|------|-------------|-------|
| `plugins/genesis-tools/commands/setup.md` | 2 | `name:` + inline `/genesis-tools:setup` |
| `plugins/genesis-tools/commands/github-pr.md` | 2 | `name:` + inline ref to `genesis-tools:github` skill |
| `plugins/genesis-tools/commands/github-pr-old.md` | 2 | `name:` + inline ref to `genesis-tools:github` skill |
| `plugins/genesis-tools/commands/question.md` | 1 | `name:` only |
| `plugins/genesis-tools/commands/claude-history.md` | 0 | No `genesis-tools:` prefix in frontmatter! Has no `name:` field at all. Skip. |

**Source code:**

| File | Line | Change |
|------|------|--------|
| `src/update/index.ts` | 149 | `` `genesis-tools:${skill.name}` `` → `` `gt:${skill.name}` `` |
| `src/react-compiler-debug/index.ts` | 457 | `"/genesis-tools:setup"` → `"/gt:setup"` |

**Historical plans (optional but recommended):**

| File | Occurrences |
|------|-------------|
| `.claude/plans/2026-02-15-GithubReviewBatchResolve.md` | 1 |
| `.claude/plans/2026-02-16-Automate.md` | 1 |
| `.claude/plans/2026-03-08-GithubReview-Skills.md` | 1 |

### Steps

**Step 1:** For every file above, replace all `genesis-tools:` with `gt:` using `replace_all`.

**Step 2:** Verify zero remaining references:

```bash
rg "genesis-tools:" plugins/ src/update/index.ts src/react-compiler-debug/index.ts .claude/plans/
```

Expected: 0 matches.

**Step 3:** Commit:

```bash
git add plugins/genesis-tools/ src/update/index.ts src/react-compiler-debug/index.ts .claude/plans/
git commit -m "refactor: rename plugin prefix genesis-tools: → gt:"
```

---

## Commit 2: Expand README Claude Code Plugin section

### Current state

The README (lines 34-101) has:
- A quick install snippet
- A summary table listing only 6 skills and 5 commands (missing 8 skills)
- A "Using Commands" section with examples
- A "Using Skills" trigger table (only 6 skills)

### Target state

Expand to include ALL skills and commands, with individual sub-sections similar to the tool detail sections further down in the README. Structure:

```
## 🎯 Claude Code Plugin
  ### Installation for Claude Code
  ### Commands
    #### `/gt:setup` — ...
    #### `/gt:github-pr` — ...
    #### `/gt:github-pr-old` — ...
    #### `/gt:question` — ...
    #### `/gt:claude-history` — ...
  ### Skills
    #### GitHub (`gt:github`)
    #### Azure DevOps (`gt:azure-devops`)
    #### Timelog (`gt:timelog`)
    #### Claude History (`gt:claude-history`)
    #### HAR Analyzer (`gt:analyze-har`)
    #### React Compiler Debug (`gt:react-compiler-debug`)
    #### TypeScript Error Fixer (`gt:typescript-error-fixer`)
    #### Git Rebaser (`gt:git-rebaser`)
    #### Automate (`gt:automate`)
    #### Codebase Analysis (`gt:codebase-analysis`)
    #### Living Docs (`gt:living-docs`)
    #### Summarize (`gt:summarize`)
    #### Writing Plans (`gt:writing-plans`)
    #### Debugging Master (`debugging-master`)
```

Each sub-section: 2-3 lines max — what it does, trigger phrases, quick example if applicable. Keep it concise like the rest of the README.

### Steps

**Step 1:** Replace the entire Claude Code Plugin section (lines 34-101) with the expanded version using the `gt:` prefix.

**Step 2:** Update the Table of Contents to add sub-anchors for Commands and Skills.

**Step 3:** Verify the README renders correctly (no broken links).

**Step 4:** Commit:

```bash
git add README.md
git commit -m "docs: expand Claude Code plugin section with all skills and commands"
```

---

## Commit 3 (final): Push & PR

```bash
git push -u origin feat/rename-plugin-skills
gh pr create \
  --title "refactor: rename plugin prefix genesis-tools: → gt:" \
  --body "$(cat <<'EOF'
## Summary
- Renames all skill/command prefixes from `genesis-tools:` to `gt:` for shorter invocation
- Expands README Claude Code Plugin section to document all 14 skills and 5 commands
- No logic changes

## Test plan
- [ ] `rg "genesis-tools:" plugins/ src/ README.md` returns 0 matches
- [ ] Start new Claude Code session, confirm skills show as `gt:*`
- [ ] Invoke `/gt:github` and `/gt:setup` to verify they load correctly
EOF
)"
```

---

**Total: ~25 files changed, 2 content commits + push/PR.**
