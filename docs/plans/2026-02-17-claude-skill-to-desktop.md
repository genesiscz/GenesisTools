# claude-skill-to-desktop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A CLI tool that syncs skills from `~/.claude/skills/` into Claude Desktop's local skill registry, with an interactive @clack/prompts multiselect to choose which skills to install.

**Architecture:** Single `src/claude-skill-to-desktop/index.ts` with Commander for CLI + @clack/prompts for interactive mode. Core logic in `lib.ts` beside it. The tool reads `~/.claude/skills/`, discovers the Claude Desktop manifest at `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/<orgId>/<pluginId>/manifest.json`, and merges entries.

**Tech Stack:** Bun, Commander, @clack/prompts, picocolors, `@app/utils/prompts/clack/helpers`, `@app/utils/readme`

---

## Background: How Claude Desktop stores skills

Skills are stored at:
```
~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/
  <orgId>/           ← stable UUID tied to Anthropic account
    <pluginId>/      ← stable UUID for the skills-plugin installation
      manifest.json  ← skill registry: { lastUpdated: number, skills: SkillEntry[] }
      skills/
        <skill-name>/
          SKILL.md   ← identical format to ~/.claude/skills/<name>/SKILL.md
```

`manifest.json` shape:
```json
{
  "lastUpdated": 1771357075987,
  "skills": [
    {
      "skillId": "skill_01XYZ...",
      "name": "slidev",
      "description": "...",
      "creatorType": "user",
      "updatedAt": "2026-01-29T19:47:11.359907Z",
      "enabled": true
    }
  ]
}
```

Source skills at `~/.claude/skills/<name>/SKILL.md` use YAML frontmatter:
```markdown
---
name: slidev          ← optional; falls back to directory name
description: "..."    ← required
---
```

---

### Task 1: Scaffold the tool directory and types

**Files:**
- Create: `src/claude-skill-to-desktop/index.ts`
- Create: `src/claude-skill-to-desktop/lib.ts`
- Create: `src/claude-skill-to-desktop/README.md`

**Step 1: Create `lib.ts` with all pure logic**

```typescript
// src/claude-skill-to-desktop/lib.ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_CODE_SKILLS = join(homedir(), ".claude", "skills");
export const CLAUDE_DESKTOP_BASE = join(
    homedir(),
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
    "skills-plugin"
);

export interface SkillEntry {
    skillId: string;
    name: string;
    description: string;
    creatorType: "user" | "anthropic";
    updatedAt: string;
    enabled: boolean;
}

export interface Manifest {
    lastUpdated: number;
    skills: SkillEntry[];
}

export interface LocalSkill {
    dirName: string;  // directory name under ~/.claude/skills/
    name: string;     // from frontmatter (falls back to dirName)
    description: string;
    sourcePath: string;
    installedEntry: SkillEntry | null;  // null if not in manifest
}

/** Find manifest.json by searching skills-plugin directory */
export function findManifestPath(): string | null {
    if (!existsSync(CLAUDE_DESKTOP_BASE)) return null;
    for (const orgId of readdirSync(CLAUDE_DESKTOP_BASE)) {
        const orgPath = join(CLAUDE_DESKTOP_BASE, orgId);
        for (const pluginId of readdirSync(orgPath)) {
            const candidate = join(orgPath, pluginId, "manifest.json");
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/** Parse YAML frontmatter from SKILL.md */
export function parseFrontmatter(content: string): { name?: string; description?: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const yaml = match[1];
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const descMatch = yaml.match(/^description:\s*([\s\S]*?)(?=\n\w|\n$|$)/m);
    const description = descMatch?.[1]?.trim().replace(/\n\s+/g, " ");
    return { name, description };
}

/** Generate a skill_01... style ID (same format as Anthropic uses) */
export function generateSkillId(): string {
    const chars = "ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz0123456789";
    let id = "skill_01";
    for (let i = 0; i < 22; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/** Discover all skills in ~/.claude/skills/ and annotate with install status */
export function discoverLocalSkills(manifest: Manifest | null): LocalSkill[] {
    if (!existsSync(CLAUDE_CODE_SKILLS)) return [];

    return readdirSync(CLAUDE_CODE_SKILLS)
        .filter((dir) => existsSync(join(CLAUDE_CODE_SKILLS, dir, "SKILL.md")))
        .map((dirName) => {
            const skillMdPath = join(CLAUDE_CODE_SKILLS, dirName, "SKILL.md");
            const content = readFileSync(skillMdPath, "utf-8");
            const { name: parsedName, description } = parseFrontmatter(content);
            const name = parsedName ?? dirName;
            const installedEntry = manifest?.skills.find((s) => s.name === name) ?? null;
            return {
                dirName,
                name,
                description: description ?? "(no description)",
                sourcePath: join(CLAUDE_CODE_SKILLS, dirName),
                installedEntry,
            };
        });
}

/** Install a single skill: copy files + update manifest */
export function installSkill(skill: LocalSkill, manifestPath: string): SkillEntry {
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const skillsDir = join(manifestPath, "..", "skills");

    // Copy directory
    const destPath = join(skillsDir, skill.name);
    mkdirSync(destPath, { recursive: true });
    cpSync(skill.sourcePath, destPath, { recursive: true });

    // Update manifest entry
    const idx = manifest.skills.findIndex((s) => s.name === skill.name);
    const entry: SkillEntry = {
        skillId: idx >= 0 ? manifest.skills[idx].skillId : generateSkillId(),
        name: skill.name,
        description: skill.description,
        creatorType: "user",
        updatedAt: new Date().toISOString(),
        enabled: true,
    };

    if (idx >= 0) {
        manifest.skills[idx] = entry;
    } else {
        manifest.skills.push(entry);
    }
    manifest.lastUpdated = Date.now();

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return entry;
}

export function readManifest(manifestPath: string): Manifest {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
}
```

**Step 2: Create `index.ts` shell (no logic yet — just Commander + imports)**

```typescript
#!/usr/bin/env bun
import { handleReadmeFlag } from "@app/utils/readme";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import {
    discoverLocalSkills, findManifestPath, installSkill, readManifest,
} from "./lib";

handleReadmeFlag(import.meta.url);

const program = new Command()
    .name("claude-skill-to-desktop")
    .description("Sync skills from ~/.claude/skills/ to Claude Desktop")
    .option("--all", "Install all skills without interactive selection")
    .option("--list", "List available skills and their install status, then exit")
    .parse();

const opts = program.opts<{ all?: boolean; list?: boolean }>();

async function main(): Promise<void> {
    // ... (implemented in Task 2)
}

main().catch((err) => {
    p.log.error(pc.red(String(err)));
    process.exit(1);
});
```

**Step 3: Create `README.md`**

```markdown
# claude-skill-to-desktop

Sync skills from `~/.claude/skills/` into Claude Desktop's local skill registry.

## Usage

```bash
tools claude-skill-to-desktop           # Interactive multiselect
tools claude-skill-to-desktop --all     # Install all skills
tools claude-skill-to-desktop --list    # List skills and install status
```

## Notes

- Requires Claude Desktop to be installed
- Restart Claude Desktop after installing to pick up changes
- Skills with `creatorType: "anthropic"` (built-ins) are never overwritten
```

**Step 4: Verify tool is discoverable**

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools
bun run src/claude-skill-to-desktop/index.ts --help
```

Expected output: Commander help showing the tool name and options.

**Step 5: Commit**

```bash
git add src/claude-skill-to-desktop/
git commit -m "feat: scaffold claude-skill-to-desktop tool"
```

---

### Task 2: Implement the interactive multiselect flow

**Files:**
- Modify: `src/claude-skill-to-desktop/index.ts`

**Step 1: Implement `main()` in `index.ts`**

Replace the `// ... (implemented in Task 2)` comment with:

```typescript
async function main(): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" claude-skill-to-desktop ")));

    // 1. Find Claude Desktop manifest
    const manifestPath = findManifestPath();
    if (!manifestPath) {
        p.cancel("Claude Desktop not found. Is it installed?");
        process.exit(1);
    }

    const manifest = readManifest(manifestPath);
    const skills = discoverLocalSkills(manifest);

    if (skills.length === 0) {
        p.cancel(`No skills found in ${CLAUDE_CODE_SKILLS}`);
        process.exit(0);
    }

    // 2. --list mode: print table and exit
    if (opts.list) {
        const lines = skills.map((s) => {
            const status = s.installedEntry ? pc.green("✓ installed") : pc.dim("  not installed");
            return `${status}  ${pc.bold(s.name)}  ${pc.dim(s.description.slice(0, 60))}`;
        });
        p.note(lines.join("\n"), `Skills in ~/.claude/skills/`);
        p.outro("Run without --list to install.");
        return;
    }

    // 3. Determine which skills to install
    let toInstall: typeof skills;

    if (opts.all) {
        toInstall = skills;
        p.log.info(`Installing all ${skills.length} skills...`);
    } else {
        // Interactive multiselect
        const selected = await withCancel(
            p.multiselect({
                message: `Select skills to install ${pc.dim("(space to toggle, enter to confirm)")}`,
                options: skills.map((s) => ({
                    value: s,
                    label: s.installedEntry
                        ? `${s.name} ${pc.dim("(already installed — will update)")}`
                        : s.name,
                    hint: s.description.length > 70 ? s.description.slice(0, 70) + "…" : s.description,
                    // Pre-select already-installed skills
                    selected: !!s.installedEntry,
                })),
                required: false,
            })
        );

        toInstall = selected as typeof skills;

        if (toInstall.length === 0) {
            p.cancel("No skills selected.");
            process.exit(0);
        }
    }

    // 4. Install selected skills
    const spinner = p.spinner();
    const results: Array<{ name: string; updated: boolean; error?: string }> = [];

    for (const skill of toInstall) {
        spinner.start(`Installing ${pc.cyan(skill.name)}...`);
        try {
            installSkill(skill, manifestPath);
            results.push({ name: skill.name, updated: !!skill.installedEntry });
            spinner.stop(
                `${pc.green("✓")} ${skill.name} ${skill.installedEntry ? pc.dim("(updated)") : pc.dim("(new)")}`
            );
        } catch (err) {
            results.push({ name: skill.name, updated: false, error: String(err) });
            spinner.stop(`${pc.red("✗")} ${skill.name}: ${String(err)}`);
        }
    }

    // 5. Summary
    const installed = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);

    if (failed.length > 0) {
        p.log.warn(`${failed.length} skill(s) failed to install.`);
    }

    p.outro(
        installed.length > 0
            ? pc.green(`${installed.length} skill(s) installed. Restart Claude Desktop to apply.`)
            : pc.red("No skills installed.")
    );
}
```

Also add `CLAUDE_CODE_SKILLS` to the imports from `./lib`.

**Step 2: Run the tool in --list mode to verify it works**

```bash
bun run src/claude-skill-to-desktop/index.ts --list
```

Expected: Table showing skills from `~/.claude/skills/` with install status.

**Step 3: Test interactive mode (check it renders multiselect)**

```bash
bun run src/claude-skill-to-desktop/index.ts
```

Expected: `@clack/prompts` multiselect with all skills, already-installed ones pre-checked.

**Step 4: Test --all mode**

```bash
bun run src/claude-skill-to-desktop/index.ts --all
```

Expected: All skills installed, spinner per skill, success outro.

**Step 5: Commit**

```bash
git add src/claude-skill-to-desktop/index.ts
git commit -m "feat: implement interactive skill install with clack multiselect"
```

---

### Task 3: Type-check and verify with tsgo

**Step 1: Run tsgo on the new tool files**

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools
tsgo --noEmit | rg "claude-skill-to-desktop"
```

Expected: No errors. If any appear, fix them before continuing.

**Step 2: Fix any type errors**

Common issues:
- `readdirSync` returns `string[] | Dirent[]` — cast with `{ withFileTypes: false }` or use `as string[]`
- `cpSync` may need `{ recursive: true }` typed explicitly
- `manifest.skills.find()` returns `SkillEntry | undefined` — use `?? null`

**Step 3: Commit if fixes were needed**

```bash
git add src/claude-skill-to-desktop/
git commit -m "fix: type errors in claude-skill-to-desktop"
```

---

### Task 4: Smoke test and final polish

**Step 1: Run via `tools` command**

```bash
tools claude-skill-to-desktop --list
tools claude-skill-to-desktop --help
```

Expected: Works identically to running via `bun run`.

**Step 2: Verify a real install round-trip**

1. Note a skill not in Claude Desktop (e.g. `feature-scaffold` if it was removed)
2. Run `tools claude-skill-to-desktop`, select it
3. Check the manifest was updated:

```bash
cat "$HOME/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin"/*/*/manifest.json \
  | grep feature-scaffold
```

Expected: Entry present with `"creatorType": "user"` and `"enabled": true`.

**Step 3: Final commit**

```bash
git add src/claude-skill-to-desktop/
git commit -m "feat: claude-skill-to-desktop tool complete"
```
