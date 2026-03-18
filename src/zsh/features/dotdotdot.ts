import type { ZshFeature } from "./types.ts";

export const dotdotdotFeature: ZshFeature = {
    name: "dotdotdot",
    description: "Expand ... to ../.. (N dots → N-1 segments), works with Tab completion",
    shellOnly: "zsh",
    shellScript: `
__genesis_dotdotdot_expand_buf() {
    local old_len=\${#BUFFER}
    local buf="$BUFFER"
    # Process from longest (10 dots) down to 3 to avoid partial matches
    local i ndots chain j
    for (( i=10; i>=3; i-- )); do
        ndots=""
        for (( j=0; j<i; j++ )); do
            ndots="\${ndots}."
        done
        chain=".."
        for (( j=2; j<i; j++ )); do
            chain="../\${chain}"
        done
        buf="\${buf//\${ndots}/\${chain}}"
    done
    BUFFER="$buf"
    (( CURSOR += \${#BUFFER} - old_len ))
}

__genesis_dotdotdot_collapse_buf() {
    local left="$LBUFFER"
    local right="$RBUFFER"
    local i chain ndots j
    for (( i=10; i>=3; i-- )); do
        chain=".."
        for (( j=2; j<i; j++ )); do
            chain="../\${chain}"
        done
        ndots=""
        for (( j=0; j<i; j++ )); do
            ndots="\${ndots}."
        done
        left="\${left//\${chain}/\${ndots}}"
        right="\${right//\${chain}/\${ndots}}"
    done
    LBUFFER="$left"
    RBUFFER="$right"
}

__genesis_dotdotdot_accept() {
    __genesis_dotdotdot_expand_buf
    zle __genesis_dotdotdot_saved_accept
}

__genesis_dotdotdot_complete() {
    local orig="$BUFFER"
    __genesis_dotdotdot_expand_buf
    local did_expand=0
    [[ "$orig" != "$BUFFER" ]] && did_expand=1

    zle __genesis_dotdotdot_saved_complete

    if (( did_expand )); then
        __genesis_dotdotdot_collapse_buf
    fi
}

# Bind widgets only if not already bound (prevents circular reference on re-source)
if [[ "$(zle -lL accept-line 2>/dev/null)" != *__genesis_dotdotdot_accept* ]]; then
    zle -A accept-line __genesis_dotdotdot_saved_accept
    zle -N accept-line __genesis_dotdotdot_accept
fi

# Hook whatever widget Tab (^I) is currently bound to
typeset __tab_widget=\${$(bindkey "^I")[(w)2]}
if [[ -n "$__tab_widget" && "$(zle -lL "$__tab_widget" 2>/dev/null)" != *__genesis_dotdotdot_complete* ]]; then
    zle -A "$__tab_widget" __genesis_dotdotdot_saved_complete
    zle -N "$__tab_widget" __genesis_dotdotdot_complete
fi`.trim(),
};
