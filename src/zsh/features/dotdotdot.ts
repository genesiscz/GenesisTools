import type { ZshFeature } from "./types.ts";

export const dotdotdotFeature: ZshFeature = {
    name: "dotdotdot",
    description: "Expand ... to ../.. (N dots → N-1 segments)",
    shellOnly: "zsh",
    shellScript: `
__genesis_dotdotdot_expand() {
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
    zle "\${__genesis_dotdotdot_saved_widget:-accept-line}"
}
zle -A accept-line __genesis_dotdotdot_saved_widget
zle -N accept-line __genesis_dotdotdot_expand
`.trim(),
};