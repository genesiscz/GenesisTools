import { resolve } from "node:path";

export function renderCaptureShell(
    options: { bunPath?: string; recorderPath?: string; directory?: string; preferPathBun?: boolean } = {}
): string {
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const bunPath = quote(options.bunPath ?? process.execPath);
    const selectedBun = options.preferPathBun ? `\${commands[bun]:-${bunPath}}` : bunPath;
    const recorderPath = quote(options.recorderPath ?? resolve(import.meta.dir, "../capture-record.ts"));
    const directory = options.directory
        ? quote(options.directory)
        : '"${GENESIS_TOOLS_HOME:-$HOME}/.genesis-tools/cmux/command-journal"';
    return `# Lightweight cmux command capture. Source this from ~/.zshrc.
[[ -o interactive && -n "$CMUX_SURFACE_ID" ]] || return 0
[[ -z "$CMUX_CAPTURE_OWNER" || "$CMUX_CAPTURE_OWNER" = "$$" ]] || return 0
[[ "$CMUX_SURFACE_ID" =~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' ]] || return 0
export CMUX_CAPTURE_OWNER=$$
zmodload zsh/datetime || return 0
zmodload zsh/stat || return 0
typeset -g _GENESIS_CMUX_CAPTURE_DIRECTORY=${directory}
typeset -g _GENESIS_CMUX_CAPTURE_BUN=${selectedBun}
typeset -g _GENESIS_CMUX_CAPTURE_ASSOCIATE_AT=\${_GENESIS_CMUX_CAPTURE_ASSOCIATE_AT:-0}
(umask 077; command mkdir -p -- "$_GENESIS_CMUX_CAPTURE_DIRECTORY") || return 0
autoload -Uz add-zsh-hook
_genesis_cmux_capture_associate() {
    local alias="$_GENESIS_CMUX_CAPTURE_DIRECTORY/\${CMUX_SURFACE_ID:l}.identity"
    local identity=""
    [[ -r "$alias" ]] && identity=$(<"$alias")
    if [[ ! "$identity" =~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' && -x "$_GENESIS_CMUX_CAPTURE_BUN" && -r ${recorderPath} ]] && (( EPOCHSECONDS - _GENESIS_CMUX_CAPTURE_ASSOCIATE_AT > 30 )); then
        typeset -g _GENESIS_CMUX_CAPTURE_ASSOCIATE_AT=$EPOCHSECONDS
        command "$_GENESIS_CMUX_CAPTURE_BUN" ${recorderPath} --associate "$CMUX_SURFACE_ID" "$_GENESIS_CMUX_CAPTURE_DIRECTORY" </dev/null >/dev/null 2>/dev/null &!
    fi
}
_genesis_cmux_capture_associate
_genesis_cmux_capture_write() {
    setopt localoptions
    unsetopt multibyte
    local spool="$_GENESIS_CMUX_CAPTURE_DIRECTORY/\${CMUX_SURFACE_ID:l}.shell"
    local -a spool_size
    if [[ -f "$spool" ]]; then
        zstat -A spool_size +size "$spool" || return 1
        if (( spool_size[1] > 900000 )); then
            command mv -f -- "$spool" "$spool.previous" || return 1
        fi
    fi
    if (( \${#_GENESIS_CMUX_CAPTURE_COMMAND} > 65536 )); then
        return 1
    fi
    (umask 077; print -rn -- $'\\0'"1"$'\\0'"$CMUX_SURFACE_ID"$'\\0'"$1"$'\\0'"$_GENESIS_CMUX_CAPTURE_CWD"$'\\0'"$CMUX_WORKSPACE_ID"$'\\0'"$2"$'\\0'"$EPOCHREALTIME"$'\\0'"\${#_GENESIS_CMUX_CAPTURE_COMMAND}"$'\\0'"$_GENESIS_CMUX_CAPTURE_COMMAND"$'\\0' >> "$spool")
}
_genesis_cmux_capture_preexec() {
    if [[ "$1" == 'function _genesis_cmux_restore_internal '* ]]; then
        unset _GENESIS_CMUX_CAPTURE_COMMAND _GENESIS_CMUX_CAPTURE_CWD
        return 0
    fi
    typeset -g _GENESIS_CMUX_CAPTURE_COMMAND="$1"
    typeset -g _GENESIS_CMUX_CAPTURE_CWD="$PWD"
    _genesis_cmux_capture_associate
    _genesis_cmux_capture_write running '' || print -u2 -- 'cmux command capture failed; this command may not be recoverable'
    return 0
}
_genesis_cmux_capture_precmd() {
    local command_status=$?
    if [[ -n "$_GENESIS_CMUX_CAPTURE_COMMAND" ]]; then
        # The record's cwd is the shell's cwd AT WRITE TIME, so a completed \`cd\`
        # reports where the shell now is. Keeping the preexec value here would make
        # restore --no-replay land in the directory the cd left.
        typeset -g _GENESIS_CMUX_CAPTURE_CWD="$PWD"
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
