import { formatAudioLibrary, parseSoundSpec } from "@app/utils/audio/library";
import { SafeJSON } from "@app/utils/json";
import { setVaultRoot } from "@app/utils/obsidian/config";
import type { Command } from "commander";
import { loadConfig, type QuestionConfig, saveConfig } from "../lib/config";

function failWithSounds(message: string): never {
    process.stderr.write(`error: ${message}\n\n${formatAudioLibrary()}\n`);
    process.exit(1);
}

export function registerConfigCommand(program: Command): void {
    program
        .command("config")
        .description("Read/update question sink config (sound, notify, obsidian template)")
        .option("--sound [spec]", "synth:<preset> | bundled:<file> | custom:<path> | off")
        .option("--sound-volume <n>", "0..1", (v) => Number.parseFloat(v))
        .option("--notify <onoff>", "on|off")
        .option("--obsidian <onoff>", "on|off")
        .option("--obsidian-vault <path>", "set the Obsidian vault override")
        .option("--list-sounds", "list every available sound (bundled + synth) and exit")
        .action(
            (o: {
                sound?: string | boolean;
                soundVolume?: number;
                notify?: string;
                obsidian?: string;
                obsidianVault?: string;
                listSounds?: boolean;
            }) => {
                if (o.listSounds) {
                    process.stdout.write(`${formatAudioLibrary()}\n`);
                    process.exit(0);
                }

                let next: QuestionConfig = loadConfig();

                if (o.sound !== undefined) {
                    if (o.sound === true || o.sound === "") {
                        failWithSounds("--sound needs a value");
                    }

                    const parsed = parseSoundSpec(o.sound as string);
                    if (!parsed.ok) {
                        failWithSounds(parsed.error);
                    }

                    next = saveConfig({
                        sinks: { ...next.sinks, sound: parsed.enabled },
                        ...(parsed.sound ? { sound: parsed.sound } : {}),
                    });
                }

                if (typeof o.soundVolume === "number" && !Number.isNaN(o.soundVolume)) {
                    next = saveConfig({ soundVolume: Math.max(0, Math.min(1, o.soundVolume)) });
                }

                if (o.notify === "on" || o.notify === "off") {
                    next = saveConfig({ sinks: { ...next.sinks, notify: o.notify === "on" } });
                }

                if (o.obsidian === "on" || o.obsidian === "off") {
                    next = saveConfig({ sinks: { ...next.sinks, obsidian: o.obsidian === "on" } });
                }

                if (o.obsidianVault) {
                    setVaultRoot(o.obsidianVault);
                }

                process.stdout.write(`${SafeJSON.stringify(next, null, 2)}\n`);
                process.exit(0);
            }
        );
}
