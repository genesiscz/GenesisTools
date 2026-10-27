/** Commander's repeatable-option collector: `--image a --image b` gives `["a", "b"]`. */
export function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}
