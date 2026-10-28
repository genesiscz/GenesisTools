# Sources

The `architecture` skill was written on 2026-10-28. It restates its sources in its own words and adds the
GenesisTools examples. The one quoted line is attributed below. Commit hashes are the upstream heads that were read.

## 1. Balanced Coupling: `balanced-coupling`, `review`, `document`

- Source: https://github.com/vladikk/modularity (commit `bcdca9a5`, 2026-04-04), folder `skills/`. The model's
  own site is https://coupling.dev.
- Author and license: Vlad Khononov. CC BY-NC-SA 4.0 (Attribution, NonCommercial, ShareAlike).
- Local copy: the main checkout's `.claude/skills/balanced-coupling/`, `review/` and `document/`, installed with
  `bunx skills add vladikk/modularity --skill balanced-coupling --skill review --skill document --agent claude-code --copy -y`.
  They are kept out of git with entries in `.git/info/exclude`, so a linked worktree does not have them.
- What this skill took: a link between two parts has three dimensions (how much knowledge it shares, how far apart
  the parts are, and how often they change). Volatility is the input that turns "think about the future" into a
  method. Commit frequency can be accidental, so judge volatility from the domain. A capability that several
  vendors could supply needs a strong contract around it. An imbalance in a part that never changes is tolerable,
  so stable code is not refactored only for tidiness. The balance rule, quoted from `balanced-coupling`, section
  4.3: "BALANCE = (STRENGTH XOR DISTANCE) OR NOT VOLATILITY".
- Read the original for a design review of an area, a decision to split or merge modules, or an explanation of why
  a change cascades. `review` is the procedure, and `document` writes its report.

## 2. `api-and-interface-design` and `deprecation-and-migration`

- Source: https://github.com/addyosmani/agent-skills (commit `aeac41d4`, 2026-10-13), folders
  `skills/api-and-interface-design/` and `skills/deprecation-and-migration/`.
- Author and license: Addy Osmani. MIT (Copyright (c) 2025 Addy Osmani).
- Local copy: `api-and-interface-design` is installed and committed in `.claude/skills/api-and-interface-design/`,
  with the upstream MIT notice in its `LICENSE`. `deprecation-and-migration` was read with `gh api` and is not
  installed.
- What this skill took: define the contract first. Every observable behaviour becomes a promise (Hyrum's law), so
  a saved JSON shape is an API. Prefer adding optional fields to changing existing ones. Keep one version, and
  extend it rather than fork it. Model variants as discriminated unions. Validate at the boundaries. From the
  migration skill: expand, then migrate, then contract; old and new must both work at every step; the destructive
  step comes last and alone; whoever owns the old shape migrates its users.
- Read the original when you design a public interface, a saved shape or a flag set, or when you plan to remove an
  old key, flag or API.

## 3. `codebase-design` and `improve-codebase-architecture`

- Source: https://github.com/mattpocock/skills (commit `59db609e`, 2026-10-27), folder
  `skills/engineering/codebase-design/` (`SKILL.md`, `DEEPENING.md`, `DESIGN-IT-TWICE.md`) and
  `skills/engineering/improve-codebase-architecture/`.
- Author and license: Matt Pocock. MIT (Copyright (c) 2026 Matt Pocock).
- Local copy: `improve-codebase-architecture` is a user-level skill (`~/.claude/skills/`) that only the user can
  start. `codebase-design` was not installed on the machine where this skill was written, so the upstream copy was
  read.
- What this skill took: the vocabulary (module, interface, implementation, depth, seam, adapter, leverage,
  locality). The deletion test. The interface is the test surface. One adapter makes a hypothetical seam and two
  make a real one, and a test adapter can be the second.
- Read the original to deepen a cluster of shallow modules, to place a seam, or to compare several interface
  designs in parallel (design it twice).

## 4. `clean-ddd-hexagonal`

- Source: https://github.com/ccheney/robust-skills (commit `0eea7b06`, 2026-09-12), folder
  `skills/clean-ddd-hexagonal/` (`SKILL.md` and `references/HEXAGONAL.md`, `LAYERS.md`, `CHEATSHEET.md` were read).
- Author and license: robust-skills contributors (GitHub `ccheney`). MIT.
- Local copy: none. It was read with `gh api` as a reference.
- What this skill took: source dependencies point at the side that owns the abstraction. The core defines the
  ports it needs, and adapters implement them from outside. One place wires the implementations together (here,
  the exhaustive table). A port is stated in domain terms and leaks no technology. Simple code can stay simple.
- Read the original for a subsystem with real domain rules, for layering questions, or for CQRS and events.

## 5. The rule this skill implements

- Source: the maintainer's user-level instructions (GenesisClaude `user/CLAUDE.md`, section "Design for the next
  provider (config shapes, interfaces)", added 2026-10-28). Private, not in this repository.
- What this skill took: name the axis and its owner before a key is added; a key that belongs to one provider goes
  under that provider, never flat with a comment; a saved shape changes only with a loader migration, and readers
  accept the old shape until it has run; two or more implementations get an interface, one implementation per
  provider, and a registry or factory table instead of a `switch` at the call sites; one implementation is a
  hypothetical seam; adding a provider should be one folder.
- If this skill and that rule disagree, the rule wins and this skill needs an update.

## 6. The GenesisTools findings behind the examples

- Source: the maintainer's private notes, folder `GenesisTools/2026-10-27-ModsCcxReview/`:
  `2026-10-28-AiProxyArchitectureReview.html` (Part 3, "Structure for the next provider"),
  `2026-10-28-Explore-ConfigShapesAndSeams.sonnet.md` and `2026-10-28-Research-ArchitectureSkills.sonnet.md`.
- What this skill took: the three anti-examples, the `sessionsIn` shape, the other flat shapes listed at the end of
  `examples.md`, the count of about 150 provider-name branches, the answer to "classes or functions", and the
  choice of which outside skills to install (and which to leave out because they repeat `codebase-design`).

## 7. Rules already in this repository

- `.claude/rules/agent-transcripts.md`: `NativeSessionReader` and the lints that guard the transcript seam.
- `.claude/rules/tools.md`: `@genesiscz/utils` never imports a tool, and `scripts/ci/check-package-boundaries.ts`.
- `.claude/rules/ai.md`: the AI layers import only downward, and a provider is one plugin folder.

This skill points at these rules and does not repeat them. Read the one for the area you change.
