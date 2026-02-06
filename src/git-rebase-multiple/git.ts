import { createGit } from "@app/utils/git";

const instance = createGit({ verbose: true });

export const git = instance;
export function setVerbose(enabled: boolean): void {
	instance.setVerbose(enabled);
}
export function isVerbose(): boolean {
	return instance.executor.verbose;
}
