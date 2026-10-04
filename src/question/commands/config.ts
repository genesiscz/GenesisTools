import * as p from "@clack/prompts";
import { formatAudioLibrary, parseSoundSpec } from "@genesiscz/utils/audio/library";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { setVaultRoot } from "@genesiscz/utils/obsidian/config";
import type { Command } from "commander";
import {
    ASK_VIA_QUESTION_TOOL_DESCRIPTION,
    ASK_VIA_QUESTION_TOOL_LABEL,
    loadConfig,
    type QuestionConfig,
    saveConfig,
} from "../lib/config";

const ON_OFF = ["on", "off"] as const;
const ASK_FLAG = "--ask-via-question-tool";

function failWithSounds(message: string): never {
    process.stderr.write(`error: ${message}\n\n${formatAudioLibrary()}\n`);
    process.exit(1);
}

/** On/Off picker for the opt-in, with the text that says what it changes. Null when cancelled. */
async function promptAskViaQuestionTool(current: boolean): Promise<boolean | null> {
    p.note(ASK_VIA_QUESTION_TOOL_DESCRIPTION, "How the nudge works");
    const picked = await p.select({
        message: ASK_VIA_QUESTION_TOOL_LABEL,
        initialValue: current ? "on" : "off",
        options: [
            { value: "on", label: "On", hint: `agents post every ❓ DECISION through ${toolCommand("question")}` },
            { value: "off", label: "Off", hint: "agents ask with their native tools (default)" },
        ],
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked === "on";
}

/**
 * `--ask-via-question-tool [on|off]`. Without a value: the picker in a terminal, else the possible
 * values and a filled command line (exit 1).
 */
async function resolveAskViaQuestionTool(raw: string | true, current: boolean): Promise<boolean | null> {
    if (raw === "on" || raw === "off") {
        return raw === "on";
    }

    if (raw === true && isInteractive()) {
        return promptAskViaQuestionTool(current);
    }

    process.stderr.write(
        `${suggestEnumFlag("tools question", ASK_FLAG, ON_OFF, {
            subcommand: ["config"],
            given: raw === true ? undefined : raw,
        })}\n\n${ASK_VIA_QUESTION_TOOL_DESCRIPTION}\n`
    );
    process.exitCode = 1;
    return null;
}

/** Bare `tools question config` in a terminal: pick a setting to change, or print the config. */
async function interactiveConfig(): Promise<void> {
    const current = loadConfig();
    const picked = await p.select({
        message: "Question settings",
        options: [
            {
                value: "ask",
                label: ASK_VIA_QUESTION_TOOL_LABEL,
                hint: current.askViaQuestionTool === true ? "On" : "Off",
            },
            { value: "print", label: "Print the whole config" },
        ],
    });

    if (p.isCancel(picked)) {
        return;
    }

    if (picked === "ask") {
        const value = await promptAskViaQuestionTool(current.askViaQuestionTool === true);

        if (value !== null) {
            saveConfig({ askViaQuestionTool: value });
            p.log.success(`${ASK_VIA_QUESTION_TOOL_LABEL} ${value ? "On" : "Off"}. New agent sessions pick it up.`);
        }

        return;
    }

    process.stdout.write(`${SafeJSON.stringify(current, null, 2)}\n`);
}

export function registerConfigCommand(program: Command): void {
    program
        .command("config")
        .description(
            `Read/update question config: sinks (sound, notify, obsidian) and whether agents are asked to use ${toolCommand("question")}`
        )
        .option("--sound [spec]", "synth:<preset> | bundled:<file> | custom:<path> | off")
        .option("--sound-volume <n>", "0..1", (v) => Number.parseFloat(v))
        .option("--notify <onoff>", "on|off")
        .option("--obsidian <onoff>", "on|off")
        .option("--obsidian-vault <path>", "set the Obsidian vault override")
        .option("--list-sounds", "list every available sound (bundled + synth) and exit")
        .option(`${ASK_FLAG} [onoff]`, `on|off: ${ASK_VIA_QUESTION_TOOL_LABEL} Default off.`)
        .action(
            async (o: {
                sound?: string | boolean;
                soundVolume?: number;
                notify?: string;
                obsidian?: string;
                obsidianVault?: string;
                listSounds?: boolean;
                askViaQuestionTool?: string | true;
            }) => {
                if (o.listSounds) {
                    process.stdout.write(`${formatAudioLibrary()}\n`);
                    process.exit(0);
                }

                const anyFlag = Object.values(o).some((value) => value !== undefined);

                if (!anyFlag && isInteractive()) {
                    await interactiveConfig();
                    return;
                }

                let next: QuestionConfig = loadConfig();

                if (o.askViaQuestionTool !== undefined) {
                    const value = await resolveAskViaQuestionTool(
                        o.askViaQuestionTool,
                        next.askViaQuestionTool === true
                    );

                    if (value === null) {
                        return;
                    }

                    next = saveConfig({ askViaQuestionTool: value });
                }

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

                if (o.notify !== undefined) {
                    if (o.notify !== "on" && o.notify !== "off") {
                        process.stderr.write(`error: --notify expects on|off, got '${o.notify}'\n`);
                        process.exit(1);
                    }

                    next = saveConfig({ sinks: { ...next.sinks, notify: o.notify === "on" } });
                }

                if (o.obsidian !== undefined) {
                    if (o.obsidian !== "on" && o.obsidian !== "off") {
                        process.stderr.write(`error: --obsidian expects on|off, got '${o.obsidian}'\n`);
                        process.exit(1);
                    }

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
