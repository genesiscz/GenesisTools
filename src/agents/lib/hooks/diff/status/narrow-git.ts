import { type StatusModeModule, type StatusModeSettings, unbuiltArm } from "./types";

export const narrowGitMode: StatusModeModule<StatusModeSettings["narrow-git"]> = {
    primary: () => unbuiltArm("narrow-git", "narrow-git"),
    variants: () => [],
};
