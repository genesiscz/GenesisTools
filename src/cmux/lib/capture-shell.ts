import { resolve } from "node:path";

export function renderCaptureShell(
    options: { bunPath?: string; recorderPath?: string; directory?: string; preferPathBun?: boolean } = {}
): string {
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const bunPath = options.bunPath ?? process.execPath;
    const recorderPath = options.recorderPath ?? resolve(import.meta.dir, "../capture-record.ts");
    const recorder = options.preferPathBun
        ? `"$_GENESIS_CMUX_CAPTURE_BUN" ${quote(recorderPath)}`
        : `${quote(bunPath)} ${quote(recorderPath)}`;
    const selectBun = options.preferPathBun
        ? `typeset -g _GENESIS_CMUX_CAPTURE_BUN="\${commands[bun]:-}"
if [[ -z "$_GENESIS_CMUX_CAPTURE_BUN" ]]; then
    _GENESIS_CMUX_CAPTURE_BUN=${quote(bunPath)}
fi
if [[ ! -x "$_GENESIS_CMUX_CAPTURE_BUN" ]]; then
    print -u2 -- 'cmux capture requires Bun on PATH; reinstall capture after installing Bun'
    return 0
fi
`
        : "";
    const directory = quote(options.directory ?? "");

    return `# Synchronous cmux command capture. Source this from ~/.zshrc.
[[ -o interactive && -n "$CMUX_SURFACE_ID" ]] || return 0
[[ -z "$CMUX_CAPTURE_OWNER" || "$CMUX_CAPTURE_OWNER" = "$$" ]] || return 0
${selectBun}export CMUX_CAPTURE_OWNER=$$
autoload -Uz add-zsh-hook
_genesis_cmux_capture_write() {
    print -rn -- "$_GENESIS_CMUX_CAPTURE_COMMAND" | command ${recorder} "$1" "$CMUX_SURFACE_ID" "$_GENESIS_CMUX_CAPTURE_CWD" "$CMUX_WORKSPACE_ID" "$2" ${directory}
}
_genesis_cmux_capture_preexec() {
    if [[ "$1" == 'function _genesis_cmux_restore_internal '* ]]; then
        unset _GENESIS_CMUX_CAPTURE_COMMAND _GENESIS_CMUX_CAPTURE_CWD
        return 0
    fi
    typeset -g _GENESIS_CMUX_CAPTURE_COMMAND="$1"
    typeset -g _GENESIS_CMUX_CAPTURE_CWD="$PWD"
    _genesis_cmux_capture_write running '' || print -u2 -- 'cmux command capture failed; this command may not be recoverable'
    return 0
}
_genesis_cmux_capture_precmd() {
    local command_status=$?
    if [[ -n "$_GENESIS_CMUX_CAPTURE_COMMAND" ]]; then
        _genesis_cmux_capture_write completed "$command_status" || print -u2 -- 'cmux command completion capture failed'
        unset _GENESIS_CMUX_CAPTURE_COMMAND _GENESIS_CMUX_CAPTURE_CWD
    fi
    return 0
}
add-zsh-hook -d preexec _genesis_cmux_capture_preexec
add-zsh-hook -d precmd _genesis_cmux_capture_precmd
add-zsh-hook preexec _genesis_cmux_capture_preexec
add-zsh-hook precmd _genesis_cmux_capture_precmd
`;
}
