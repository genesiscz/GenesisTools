import type { ZshFeature } from "./types.ts";

export const notifyFeature: ZshFeature = {
    name: "notify",
    description: "Notify when long-running commands finish (>= 30s)",
    shellScript: `
__genesis_notify_threshold=30

# preexec: runs BEFORE each command executes — captures command text and start time
__genesis_notify_preexec() {
    local cmd="$1"

    # Skip internal hooks — DEBUG trap fires for PROMPT_COMMAND entries too,
    # which would overwrite the real command right before precmd reads it
    if [[ "$cmd" == __genesis_notify_* ]]; then
        return
    fi

    __genesis_notify_cmd="$cmd"
    # $SECONDS is a built-in that counts seconds since shell start (float-capable)
    __genesis_notify_start=$SECONDS
}

# precmd: runs AFTER each command completes, BEFORE the next prompt is drawn
__genesis_notify_precmd() {
    # $? must be captured first — any statement after this overwrites it
    local exit_code=$?
    # No start time means no command was tracked (e.g. empty Enter)
    [[ -z "$__genesis_notify_start" ]] && return

    # (( )) is arithmetic evaluation — variables don't need $ inside
    local elapsed=$(( SECONDS - __genesis_notify_start ))

    if (( elapsed >= __genesis_notify_threshold )); then
        local cmd="\${__genesis_notify_cmd}"
        # \${#cmd} is string length; truncate long commands for the notification
        if (( \${#cmd} > 60 )); then
            # \${cmd:0:57} is substring: offset 0, length 57
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

        # Ask macOS which app is frontmost via AppleScript
        local active_app
        active_app=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
        # Normalize TERM_PROGRAM to match AppleScript app names
        local term_app
        case "\${TERM_PROGRAM:-Terminal}" in
            iTerm.app|iTerm2) term_app="iTerm2" ;;
            Apple_Terminal|Terminal.app|Terminal) term_app="Terminal" ;;
            vscode|vscode-insiders) term_app="Code" ;;
            WarpTerminal|Warp) term_app="Warp" ;;
            tmux) term_app="tmux" ;;
            *) term_app="\${TERM_PROGRAM:-Terminal}" ;;
        esac

        # Only notify if user switched away from the terminal
        if [[ "$active_app" != "$term_app" ]]; then
            local msg="\${icon} \${cmd} — \${duration}"
            # Fire notification via tools notify in background
            tools notify "\${msg}" --title "Command Finished" --sound Ping & disown 2>/dev/null
        fi
    fi

    unset __genesis_notify_start
    unset __genesis_notify_cmd
}

# --- Shell-specific hook registration ---

if [[ -n "$ZSH_VERSION" ]]; then
    autoload -Uz add-zsh-hook
    # add-zsh-hook: zsh built-in for safely chaining preexec/precmd hooks
    add-zsh-hook preexec __genesis_notify_preexec
    add-zsh-hook precmd __genesis_notify_precmd
fi
if [[ -n "$BASH_VERSION" ]]; then
    __genesis_notify_install_bash() {
        # DEBUG trap fires before every command — bash equivalent of zsh preexec
        trap '__genesis_notify_preexec "$BASH_COMMAND"' DEBUG

        # Check if already registered (PROMPT_COMMAND can be string or array)
        if [[ "\${PROMPT_COMMAND[*]}" =~ __genesis_notify_precmd ]]; then
            return
        fi

        # PROMPT_COMMAND is bash's equivalent of zsh precmd — runs before each prompt
        if [[ -z "$PROMPT_COMMAND" ]]; then
            PROMPT_COMMAND="__genesis_notify_precmd"
        # declare -p checks if PROMPT_COMMAND is an array (bash 5.1+)
        elif declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
            PROMPT_COMMAND+=("__genesis_notify_precmd")
        else
            # Prepend so we capture exit code before other handlers run
            PROMPT_COMMAND="__genesis_notify_precmd; \${PROMPT_COMMAND}"
        fi
    }
    __genesis_notify_install_bash
fi
`.trim(),
};
