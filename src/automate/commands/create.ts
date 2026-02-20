import { savePreset } from "@app/automate/lib/storage.ts";
import type { Preset, PresetStep } from "@app/automate/lib/types.ts";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerCreateCommand(program: Command): void {
    program
        .command("create")
        .description("Interactive preset creator wizard")
        .action(async () => {
            p.intro(pc.bgCyan(pc.black(" automate create ")));

            const name = await p.text({
                message: "Preset name:",
                placeholder: "My Automation",
                validate: (v) => (!v || v.length === 0 ? "Name is required" : undefined),
            });
            if (p.isCancel(name)) {
                p.cancel("Cancelled");

                process.exit(0);
            }

            const description = await p.text({
                message: "Description (optional):",
                placeholder: "What does this preset do?",
            });
            if (p.isCancel(description)) {
                p.cancel("Cancelled");

                process.exit(0);
            }

            // 2. Add steps in a loop
            const steps: PresetStep[] = [];
            let addMore = true;

            while (addMore) {
                p.log.step(pc.bold(`Step ${steps.length + 1}`));

                const actionType = await p.select({
                    message: "Action type:",
                    options: [
                        { value: "tools", label: "Tools command (tools <cmd>)" },
                        { value: "shell", label: "Shell command" },
                        { value: "if", label: "Conditional (if/then/else)" },
                        { value: "log", label: "Log a message" },
                        { value: "prompt", label: "Ask user a question" },
                        { value: "set", label: "Set a variable" },
                    ],
                });
                if (p.isCancel(actionType)) {
                    p.cancel("Cancelled");

                    process.exit(0);
                }

                const stepId = await p.text({
                    message: "Step ID (unique, alphanumeric):",
                    placeholder: `step-${steps.length + 1}`,
                    defaultValue: `step-${steps.length + 1}`,
                    validate: (v) => {
                        if (!v || !/^[a-zA-Z0-9_-]+$/.test(v)) return "Must be alphanumeric with hyphens/underscores";
                        if (steps.some((s) => s.id === v)) return "ID already used";
                        return undefined;
                    },
                });
                if (p.isCancel(stepId)) {
                    p.cancel("Cancelled");

                    process.exit(0);
                }

                const stepName = await p.text({
                    message: "Step display name:",
                    placeholder: "What this step does",
                });
                if (p.isCancel(stepName)) {
                    p.cancel("Cancelled");

                    process.exit(0);
                }

                let step: PresetStep;

                if (actionType === "tools") {
                    const action = await p.text({
                        message: "Tools command (without 'tools' prefix):",
                        placeholder: "github search",
                    });
                    if (p.isCancel(action)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }
                    step = { id: stepId, name: stepName, action };
                } else if (actionType === "shell") {
                    const command = await p.text({
                        message: "Shell command:",
                        placeholder: "ls -la",
                    });
                    if (p.isCancel(command)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }
                    step = { id: stepId, name: stepName, action: "shell", params: { command } };
                } else if (actionType === "if") {
                    const condition = await p.text({
                        message: "Condition expression (without {{ }}):",
                        placeholder: "steps.prev.output.count > 0",
                    });
                    if (p.isCancel(condition)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }

                    const thenStep = await p.text({
                        message: "Jump to step on TRUE (step ID):",
                        placeholder: "step-3",
                    });
                    if (p.isCancel(thenStep)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }

                    const elseStep = await p.text({
                        message: "Jump to step on FALSE (optional, step ID):",
                        placeholder: "step-4",
                    });
                    if (p.isCancel(elseStep)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }

                    step = {
                        id: stepId,
                        name: stepName,
                        action: "if",
                        condition: `{{ ${condition} }}`,
                        then: thenStep || undefined,
                        else: elseStep || undefined,
                    };
                } else if (actionType === "log") {
                    const message = await p.text({
                        message: "Message to log:",
                        placeholder: "Processing {{ vars.name }}...",
                    });
                    if (p.isCancel(message)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }
                    step = { id: stepId, name: stepName, action: "log", params: { message } };
                } else if (actionType === "prompt") {
                    const message = await p.text({
                        message: "Prompt message:",
                        placeholder: "Enter your name:",
                    });
                    if (p.isCancel(message)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }
                    step = { id: stepId, name: stepName, action: "prompt", params: { message } };
                } else {
                    // "set"
                    const setKey = await p.text({
                        message: "Variable name to set:",
                        placeholder: "myVar",
                    });
                    if (p.isCancel(setKey)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }

                    const setValue = await p.text({
                        message: "Value (can use {{ expressions }}):",
                        placeholder: "{{ steps.prev.output }}",
                    });
                    if (p.isCancel(setValue)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }
                    step = { id: stepId, name: stepName, action: "set", params: { [setKey]: setValue } };
                }

                // Option to store output
                const storeOutput = await p.confirm({
                    message: "Store step output in a variable?",
                    initialValue: false,
                });
                if (p.isCancel(storeOutput)) {
                    p.cancel("Cancelled");

                    process.exit(0);
                }

                if (storeOutput) {
                    const outputName = await p.text({
                        message: "Output variable name:",
                        placeholder: stepId,
                        defaultValue: stepId,
                    });
                    if (p.isCancel(outputName)) {
                        p.cancel("Cancelled");

                        process.exit(0);
                    }
                    step.output = outputName;
                }

                steps.push(step);

                const continueAdding = await p.confirm({
                    message: "Add another step?",
                    initialValue: true,
                });
                if (p.isCancel(continueAdding)) {
                    p.cancel("Cancelled");

                    process.exit(0);
                }
                addMore = continueAdding;
            }

            // 3. Build the preset object
            const preset: Preset = {
                $schema: "genesis-tools-preset-v1",
                name,
                description: description || undefined,
                trigger: { type: "manual" },
                steps,
            };

            // 4. Preview
            p.log.step("Preview:");
            p.log.info(pc.dim(JSON.stringify(preset, null, 2)));

            // 5. Save
            const shouldSave = await p.confirm({
                message: "Save this preset?",
                initialValue: true,
            });
            if (p.isCancel(shouldSave) || !shouldSave) {
                p.cancel("Preset not saved");
                process.exit(0);
            }

            const filePath = await savePreset(preset);
            p.outro(pc.green(`Saved to: ${filePath}`));
        });
}
