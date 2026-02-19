// src/automate/lib/storage.ts

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Storage } from "@app/utils/storage/storage.ts";
import type { Preset, PresetMeta } from "./types.ts";
import { validatePreset, validateStepGraph } from "./schema.ts";

const storage = new Storage("automate");
const PRESETS_DIR = "presets";
const BUNDLED_PRESETS_DIR = resolve(import.meta.dir, "../presets");

export async function ensureStorage(): Promise<void> {
  await storage.ensureDirs();
  const presetsDir = join(storage.getBaseDir(), PRESETS_DIR);
  if (!existsSync(presetsDir)) {
    mkdirSync(presetsDir, { recursive: true });
  }
  seedBundledPresets(presetsDir);
}

function seedBundledPresets(presetsDir: string): void {
  if (!existsSync(BUNDLED_PRESETS_DIR)) return;
  const bundled = readdirSync(BUNDLED_PRESETS_DIR).filter(f => f.endsWith(".json"));
  for (const file of bundled) {
    const dest = join(presetsDir, file);
    if (!existsSync(dest)) {
      copyFileSync(join(BUNDLED_PRESETS_DIR, file), dest);
    }
  }
}

/** Get the presets directory path */
export function getPresetsDir(): string {
  return join(storage.getBaseDir(), PRESETS_DIR);
}

/**
 * Load a preset by name or file path.
 * Resolution order:
 *   1. If the argument is a path to an existing .json file, load it directly.
 *   2. Otherwise look in ~/.genesis-tools/automate/presets/<name>.json
 */
export async function loadPreset(nameOrPath: string): Promise<Preset> {
  let filePath: string;

  const resolvedPath = resolve(nameOrPath);
  if (existsSync(resolvedPath) && resolvedPath.endsWith(".json")) {
    filePath = resolvedPath;
  } else {
    const presetsDir = getPresetsDir();
    const candidates = [
      join(presetsDir, `${nameOrPath}.json`),
      join(presetsDir, nameOrPath),
    ];

    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(
        `Preset "${nameOrPath}" not found. Searched:\n` +
        `  - ${resolvedPath}\n` +
        candidates.map((c) => `  - ${c}`).join("\n"),
      );
    }
    filePath = found;
  }

  const content = await Bun.file(filePath).text();
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in preset file: ${filePath}`);
  }

  const preset = validatePreset(data);

  const graphErrors = validateStepGraph(preset.steps);
  if (graphErrors.length > 0) {
    throw new Error(`Preset validation errors:\n${graphErrors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return preset as Preset;
}

/** List all presets in the presets directory with metadata */
export async function listPresets(): Promise<Array<{
  name: string;
  fileName: string;
  description?: string;
  stepCount: number;
  meta: PresetMeta;
}>> {
  const presetsDir = getPresetsDir();
  if (!existsSync(presetsDir)) return [];

  const files = readdirSync(presetsDir).filter((f) => f.endsWith(".json"));
  const result: Array<{
    name: string;
    fileName: string;
    description?: string;
    stepCount: number;
    meta: PresetMeta;
  }> = [];

  for (const file of files) {
    try {
      const content = await Bun.file(join(presetsDir, file)).text();
      const data = JSON.parse(content);
      const preset = validatePreset(data);
      const meta = await getPresetMeta(preset.name);

      result.push({
        name: preset.name,
        fileName: file,
        description: preset.description,
        stepCount: preset.steps.length,
        meta,
      });
    } catch {
      // Skip invalid preset files silently
    }
  }

  return result;
}

/** Save a preset to the presets directory. Returns the file path. */
export async function savePreset(preset: Preset): Promise<string> {
  await ensureStorage();
  const fileName = preset.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const filePath = join(getPresetsDir(), `${fileName}.json`);
  await Bun.write(filePath, JSON.stringify(preset, null, 2));
  return filePath;
}

/** Get metadata for a preset (last run date, run count) */
export async function getPresetMeta(presetName: string): Promise<PresetMeta> {
  const meta = await storage.getConfigValue<PresetMeta>(`meta.${presetName}`);
  return meta ?? {};
}

/** Update metadata after a successful run */
export async function updatePresetMeta(presetName: string): Promise<void> {
  const existing = await getPresetMeta(presetName);
  await storage.setConfigValue(`meta.${presetName}`, {
    lastRun: new Date().toISOString(),
    runCount: (existing.runCount ?? 0) + 1,
  });
}
