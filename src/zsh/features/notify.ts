import type { ZshFeature } from "./types.ts";

export const notifyFeature: ZshFeature = {
    name: "notify",
    description: "Notify when long-running commands finish (>= 30s)",
    shellScript: `
__genesis_notify_threshold=30

__genesis_notify_preexec() {
    __genesis_notify_cmd="$1"
    __genesis_notify_start=$SECONDS
}

__genesis_notify_precmd() {
    local exit_code=$?
    [[ -z "$__genesis_notify_start" ]] && return

    local elapsed=$(( SECONDS - __genesis_notify_start ))

    if (( elapsed >= __genesis_notify_threshold )); then
        local cmd="\${__genesis_notify_cmd}"
        if (( \${#cmd} > 60 )); then
            cmd="\${cmd:0:57}..."
        fi

        local icon
        if (( exit_code == 0 )); then
            icon="✅"
        else
            icon="❌"
        fi

        local minutes=$(( elapsed / 60 ))
        local seconds=$(( elapsed % 60 ))
        local duration
        if (( minutes > 0 )); then
            duration="\${minutes}m \${seconds}s"
        else
            duration="\${seconds}s"
        fi

        local active_app
        active_app=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
        local term_app="\${TERM_PROGRAM:-Terminal}"

        if [[ "$active_app" != "$term_app" ]]; then
            local escaped_cmd="\${cmd//\\\\/\\\\\\\\}"
            escaped_cmd="\${escaped_cmd//\\"/\\\\\\\\\\\\\"}"
            osascript -e "display notification \\"\${icon} \${escaped_cmd} — \${duration}\\" with title \\"Command Finished\\" sound name \\"Ping\\"" 2>/dev/null & disown 2>/dev/null
        fi
    fi

    unset __genesis_notify_start
    unset __genesis_notify_cmd
}

if [[ -n "$ZSH_VERSION" ]]; then
    autoload -Uz add-zsh-hook
    add-zsh-hook preexec __genesis_notify_preexec
    add-zsh-hook precmd __genesis_notify_precmd
fi
if [[ -n "$BASH_VERSION" ]]; then
    __genesis_notify_install_bash() {
        trap '__genesis_notify_preexec "$BASH_COMMAND"' DEBUG

        if [[ "\${PROMPT_COMMAND[*]}" =~ __genesis_notify_precmd ]]; then
            return
        fi

        if [[ -z "$PROMPT_COMMAND" ]]; then
            PROMPT_COMMAND="__genesis_notify_precmd"
        elif declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
            PROMPT_COMMAND+=("__genesis_notify_precmd")
        else
            PROMPT_COMMAND="__genesis_notify_precmd; \${PROMPT_COMMAND}"
        fi
    }
    __genesis_notify_install_bash
fi
`.trim(),
};