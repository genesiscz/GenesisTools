import { resolve, sep } from "node:path";

/**
 * Resolve `<root>/<name><suffix>` for a worker or session file, refusing any
 * name that could escape the directory.
 *
 * The name comes from `--name` on the command line, so it is checked against a
 * charset before it becomes a path AND the resolved path is checked to still be
 * under the root. The grok, codex and claude worker path modules each carried a
 * byte-identical copy of this.
 */
export function safeNamedPath(args: { root: string; name: string; suffix: string; label: string }): string {
    const { root, name, suffix, label } = args;
    const candidate = resolve(root, `${name}${suffix}`);
    const validName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

    if (!validName || !candidate.startsWith(`${root}${sep}`)) {
        throw new Error(`Invalid ${label}: ${name}`);
    }

    return candidate;
}
