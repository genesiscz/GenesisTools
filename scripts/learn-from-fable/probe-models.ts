/**
 * The models a learn-from-fable probe runs: each `--model <ref>` on its command line, else the fable config's model
 * for each stage the probe measures (`models.<stage>` in config.json, a full `<account>/<provider>/<model>` proxy id,
 * the same one `tools learn-from-fable` uses). A probe never carries an account name or a model id of its own, so it
 * follows the config when a release moves the stage (lint-rules `no-model-id-literal-outside-catalog`).
 */
import { type FableStageModels, loadFableConfig, requireStageModel } from "../../src/learn-from-fable/lib/config";

export interface ProbeArgs {
    /** The first model: the one a single-model probe runs. */
    model: string;
    models: string[];
    /** The command line without the `--model <ref>` pairs, so the positional arguments keep their order. */
    args: string[];
}

export function probeArgs(stages: Array<keyof FableStageModels>, argv: string[] = process.argv.slice(2)): ProbeArgs {
    const flagged: string[] = [];
    const args: string[] = [];

    for (let index = 0; index < argv.length; index++) {
        if (argv[index] !== "--model") {
            args.push(argv[index]);
            continue;
        }

        const value = argv[index + 1];

        if (!value) {
            throw new Error("--model needs a value: a full <account>/<provider>/<model> proxy id.");
        }

        flagged.push(value);
        index++;
    }

    const models = flagged.length > 0 ? flagged : stageModels(stages);

    return { model: models[0], models, args };
}

function stageModels(stages: Array<keyof FableStageModels>): string[] {
    const config = loadFableConfig();

    if (!config) {
        throw new Error(
            "No fable config found. Run `tools learn-from-fable bootstrap`, or pass --model <account>/<provider>/<model>."
        );
    }

    return stages.map((stage) => requireStageModel(config, stage));
}
