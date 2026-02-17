import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    dirName: string;
    name: string;
    description: string;
    sourcePath: string;
    installedEntry: SkillEntry | null;
}

export function findManifestPath(): string | null {
    if (!existsSync(CLAUDE_DESKTOP_BASE)) return null;
    for (const orgEntry of readdirSync(CLAUDE_DESKTOP_BASE, { withFileTypes: true })) {
        if (!orgEntry.isDirectory()) continue;
        const orgPath = join(CLAUDE_DESKTOP_BASE, orgEntry.name);
        for (const pluginEntry of readdirSync(orgPath, { withFileTypes: true })) {
            if (!pluginEntry.isDirectory()) continue;
            const candidate = join(orgPath, pluginEntry.name, "manifest.json");
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

export function parseFrontmatter(content: string): { name?: string; description?: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const yaml = match[1];
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const descMatch = yaml.match(/^description:\s*(.+(?:\n[ \t]+.+)*)/m);
    const description = descMatch?.[1]?.replace(/\n[ \t]+/g, " ").trim();
    return { name, description };
}

export function generateSkillId(): string {
    const chars = "ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz0123456789";
    let id = "skill_01";
    for (let i = 0; i < 22; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

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

export function installSkill(skill: LocalSkill, manifest: Manifest, manifestPath: string): SkillEntry {
    const skillsDir = join(manifestPath, "..", "skills");
    const destPath = join(skillsDir, skill.name);
    if (existsSync(destPath)) rmSync(destPath, { recursive: true });
    mkdirSync(destPath, { recursive: true });
    cpSync(skill.sourcePath, destPath, { recursive: true });
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
    try {
        return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    } catch (e) {
        throw new Error(`Failed to read manifest at ${manifestPath}: ${String(e)}`);
    }
}
