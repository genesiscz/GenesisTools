/** `launchctl list`: `PID\tStatus\tLabel`, a `-` pid for a job that is not running. */
export function parseLaunchctlList(stdout: string): Map<number, string> {
    const jobs = new Map<number, string>();

    for (const line of stdout.split("\n")) {
        const [pid, , label] = line.split("\t");
        const value = Number.parseInt(pid ?? "", 10);

        if (Number.isInteger(value) && value > 0 && label) {
            jobs.set(value, label.trim());
        }
    }

    return jobs;
}
