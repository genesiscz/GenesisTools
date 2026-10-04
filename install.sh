#!/bin/bash

check_bun_installed() {
    if command -v bun &> /dev/null; then
        echo "✅ Bun is installed"
        return 0
    fi

    echo "❌ Bun is not installed."
    echo ""
    echo "This project requires Bun because it uses Bun runtime-only tools."
    echo ""
    echo "To install Bun, run:"
    echo ""
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$OSTYPE" == "cygwin" ]]; then
        echo "  powershell -c \"irm bun.sh/install.ps1|iex\""
    else
        echo "  curl -fsSL https://bun.sh/install | bash"
    fi
    echo ""
    return 1
}

install_dependencies() {
    if [ -d "node_modules" ]; then
        echo "✅ Dependencies already installed"
        return 0
    fi

    echo "📦 Installing dependencies..."
    if ! bun install; then
        echo "❌ Failed to install dependencies"
        return 1
    fi

    echo "✅ Dependencies installed"
    return 0
}

# `xcode-select -p` without the real Xcode is a few-ms spawn; a fake binary earlier on PATH
# makes this testable (see install.test.ts). CLT path ends in /CommandLineTools; Xcode is under
# *.app/Contents/Developer. Mirrors src/utils/macos/xcode.ts's classification for the same reason
# that file exists: a build under the Command Line Tools fails with 100+ SwiftUI macro errors.
detect_xcode_toolchain() {
    local dev_dir
    dev_dir="$(xcode-select -p 2>/dev/null)"

    if [ -z "$dev_dir" ]; then
        echo "none"
    elif [[ "$dev_dir" == */CommandLineTools ]]; then
        echo "command-line-tools"
    else
        echo "xcode"
    fi
}

# #445: building GenesisTools.app used to happen silently on every install. It is asked for now
# ([Y/n], the prompt #445 proposed), and refused up front without the full Xcode: a Command Line
# Tools-only build fails with 100+ cascading SwiftUI macro errors instead of one clear message.
# Sets GENESIS_APP_BUILT=true only when THIS run installed the app; print_genesis_app_summary
# checks for an install from an earlier run itself.
offer_genesis_app_build() {
    GENESIS_APP_BUILT=false

    if [[ "$OSTYPE" != darwin* ]]; then
        return 0
    fi

    if ! command -v swift &> /dev/null; then
        echo "⚠️  swift not found; skipping GenesisTools.app. It needs the full Xcode app (the Command Line Tools are not enough): install Xcode, then run: bun run build:app"
        return 0
    fi

    local toolchain
    toolchain="$(detect_xcode_toolchain)"

    if [ "$toolchain" = "command-line-tools" ]; then
        echo "⚠️  GenesisTools.app needs the full Xcode (SwiftUI macros are not in the Command Line Tools): install Xcode, select it with \`sudo xcode-select -s <path to your Xcode.app>\` (for example /Applications/Xcode.app), then \`tools macos permissions build\`."
        return 0
    fi

    if [ ! -t 0 ]; then
        echo "ℹ️  Not running in a terminal; skipping GenesisTools.app. Build it later with: bun run build:app"
        return 0
    fi

    echo "GenesisTools.app is a signed launcher that lets macOS privacy grants (Calendars, Reminders, Full Disk Access, ...) follow it instead of your terminal."
    local build_answer
    read -r -p "Build and install GenesisTools.app now? [Y/n] " build_answer

    case "$build_answer" in
        [nN]*)
            echo "⏭️  Skipping GenesisTools.app. Build it later with: bun run build:app"
            return 0
            ;;
    esac

    echo "🔐 Building GenesisTools.app (TCC identity)..."
    if bun run src/macos/index.ts permissions build; then
        echo "✅ GenesisTools.app installed at ~/Applications (grant it Full Disk Access once: tools macos permissions open --pane full-disk-access)"
        GENESIS_APP_BUILT=true
    else
        echo "⚠️  GenesisTools.app build failed; tools will run under the terminal's permissions. Retry with: bun run build:app"
    fi

    return 0
}

# #445 comment item 4: the closing summary must say plainly when GenesisTools.app is missing
# and what that means, rather than just "Setup complete" — a silent gap here is how the old
# "build it quietly, mention nothing if it fails" behavior went unnoticed.
print_genesis_app_summary() {
    if [[ "$OSTYPE" != darwin* ]]; then
        return 0
    fi

    if [ "$GENESIS_APP_BUILT" = true ]; then
        return 0
    fi

    # GENESIS_APP_BUILT covers this run only; the launcher an earlier run installed is still in use.
    # Same path as genesisAppLauncherPath() in src/utils/macos/genesis-app.ts.
    if [ -f "$HOME/Applications/GenesisTools.app/Contents/MacOS/GenesisTools" ]; then
        echo "ℹ️  GenesisTools.app is installed (not rebuilt this run). Rebuild it with: bun run build:app"
        return 0
    fi

    echo "ℹ️  GenesisTools.app is not installed: permission-based tools (Calendar, Reminders, Full Disk Access, ...) use your terminal's own permissions. Build it later with: bun run build:app"
}

# $1: a shell path ($SHELL) or a process name from `ps -o comm=` ("-zsh" for a login shell, or a
# bare "bash"). Echoes the rc file basename this shell reads, or nothing when the shell is not
# one we know how to configure.
shell_rc_filename() {
    local name="${1##*/}"
    name="${name#-}"

    case "$name" in
        zsh) echo ".zshrc" ;;
        bash) echo ".bashrc" ;;
        *) echo "" ;;
    esac
}

# The shell that ran install.sh. $SHELL is only the LOGIN shell: someone who typed `bash` inside
# zsh (or the reverse) runs the installer from a different shell, and that one needs its rc file
# too. A non-shell parent (make, a package script) maps to no rc file and is ignored.
invoking_shell() {
    ps -o comm= -p "$PPID" 2>/dev/null
}

# $1: the invoking shell, $2: $SHELL. The rc file to `source` right now is the one of the shell
# the user is typing in; the login shell's is the fallback.
reload_rc_filename() {
    local rc
    rc="$(shell_rc_filename "$1")"

    if [ -z "$rc" ]; then
        rc="$(shell_rc_filename "$2")"
    fi

    echo "$rc"
}

# $2 ("true"/"false", default "true"): whether to create the file when it does not exist yet.
add_to_shell_config() {
    local shell_config_file="$1"
    local allow_create="${2:-true}"

    if [ -f "$shell_config_file" ]; then
        if grep -Fqx "$TOOLS_LINE" "$shell_config_file"; then
            echo "✅ $CURRENT_DIR is already in PATH in $shell_config_file"
        elif grep -q "GENESIS_TOOLS_PATH" "$shell_config_file"; then
            # Stale path from a previous installation — replace it
            grep -v "GENESIS_TOOLS_PATH" "$shell_config_file" > "${shell_config_file}.tmp"
            mv "${shell_config_file}.tmp" "$shell_config_file"
            echo "$TOOLS_LINE" >> "$shell_config_file"
            echo "$EXPORT_LINE" >> "$shell_config_file"
            echo "📝 Updated GENESIS_TOOLS_PATH in $shell_config_file"
            SHELL_CONFIG_CHANGED=true
        else
            echo "$TOOLS_LINE" >> "$shell_config_file"
            echo "$EXPORT_LINE" >> "$shell_config_file"
            echo "📝 Added $CURRENT_DIR to PATH in $shell_config_file"
            SHELL_CONFIG_CHANGED=true
        fi
    elif [ "$allow_create" = "true" ]; then
        echo "$TOOLS_LINE" > "$shell_config_file"
        echo "$EXPORT_LINE" >> "$shell_config_file"
        echo "➕ Created $shell_config_file and added $CURRENT_DIR to PATH"
        SHELL_CONFIG_CHANGED=true
    fi
}

# #446 item 11: only touch an rc file that already exists, plus the ones belonging to $SHELL ($2)
# and to the shell the installer runs in ($3), each created if missing. The old version always
# created ~/.bashrc, even on a zsh-only Mac where bash login shells read ~/.bash_profile and
# ~/.bashrc is never sourced.
update_unix_shell_configs() {
    local home_dir="$1"
    local login_rc invoking_rc
    login_rc="$(shell_rc_filename "$2")"
    invoking_rc="$(shell_rc_filename "${3:-}")"

    local rc
    for rc in ".zshrc" ".bashrc"; do
        local path="$home_dir/$rc"

        if [ -f "$path" ] || [ "$rc" = "$login_rc" ] || [ "$rc" = "$invoking_rc" ]; then
            add_to_shell_config "$path" true
        fi
    done
}

run_windows_setup() {
    local current_dir="$1"
    # Convert MSYS/Cygwin path to Windows path for setx
    local win_dir
    win_dir="$(cygpath -w "$current_dir" 2>/dev/null || echo "$current_dir")"

    # Set GENESIS_TOOLS_PATH as a persistent user environment variable
    if setx GENESIS_TOOLS_PATH "$win_dir" > /dev/null 2>&1; then
        echo "📝 Set GENESIS_TOOLS_PATH=$win_dir"
    else
        echo "❌ Failed to set GENESIS_TOOLS_PATH via setx"
        exit 1
    fi

    # Add to user PATH if not already present (case-insensitive check)
    export WIN_DIR="$win_dir"
    local has_path_entry
    has_path_entry="$(powershell.exe -NoProfile -Command "\
      \$p=[Environment]::GetEnvironmentVariable('Path','User'); \
      \$target=\$env:WIN_DIR; \
      if ((\$p -split ';') | Where-Object { \$_.Trim() -ieq \$target }) { 'true' } else { 'false' }" 2>/dev/null | tr -d '\r')"
    if [ "$has_path_entry" = "true" ]; then
        echo "✅ $win_dir is already in user PATH"
    else
        local current_path
        current_path="$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'User')" 2>/dev/null | tr -d '\r')"
        export NEW_PATH="${current_path:+$current_path;}$win_dir"
        if powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', \$env:NEW_PATH, 'User')" 2>/dev/null; then
            echo "📝 Added $win_dir to user PATH"
            SHELL_CONFIG_CHANGED=true
        else
            echo "❌ Failed to add to user PATH"
            exit 1
        fi
    fi

    # Also update current session
    export GENESIS_TOOLS_PATH="$current_dir"
    export PATH="$current_dir:$PATH"

    # Create tools.cmd wrapper for CMD/PowerShell
    local tools_cmd="$current_dir/tools.cmd"
    cat > "$tools_cmd" << 'CMDEOF'
@echo off
bun run "%~dp0tools" %*
CMDEOF
    # Convert to CRLF for Windows batch compatibility
    sed -i 's/$/\r/' "$tools_cmd" 2>/dev/null
    echo "✅ Created tools.cmd for CMD/PowerShell"
}

main() {
    if ! check_bun_installed; then
        exit 1
    fi

    CURRENT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    cd "$CURRENT_DIR" || exit 1

    if ! install_dependencies; then
        exit 1
    fi

    offer_genesis_app_build

    IS_WINDOWS=false
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$OSTYPE" == "cygwin" ]]; then
        IS_WINDOWS=true
    fi

    SHELL_CONFIG_CHANGED=false

    if [ "$IS_WINDOWS" = true ]; then
        run_windows_setup "$CURRENT_DIR"
    else
        TOOLS_LINE="export GENESIS_TOOLS_PATH=\"$CURRENT_DIR\""
        EXPORT_LINE="export PATH=\"\$GENESIS_TOOLS_PATH:\$PATH\""

        INVOKING_SHELL="$(invoking_shell)"
        update_unix_shell_configs "$HOME" "$SHELL" "$INVOKING_SHELL"

        # Make tools available for the rest of the script
        export PATH="$CURRENT_DIR:$PATH"
    fi

    # Run update (plugin setup, changelog, etc.)
    echo "🔄 Running tools update..."
    if ! tools update; then
        echo "❌ tools update failed"
        exit 1
    fi

    echo ""
    print_genesis_app_summary
    echo "🎉 Setup complete."

    if [ "$IS_WINDOWS" = true ]; then
        if [ "$SHELL_CONFIG_CHANGED" = true ]; then
            echo "   Please restart your terminal for PATH changes to take effect."
        fi
        echo "   In Git Bash:      tools <command>"
        echo "   In CMD/PowerShell: tools <command>"
    else
        if [ "$SHELL_CONFIG_CHANGED" = true ]; then
            echo "   Please restart your terminal or run:"
            local reload_rc
            reload_rc="$(reload_rc_filename "$INVOKING_SHELL" "$SHELL")"

            if [ -n "$reload_rc" ]; then
                echo "     source ~/$reload_rc"
            else
                echo "     source your shell config"
            fi
        fi
    fi
}

# Sourced (by install.test.ts) only defines the functions above; a direct run executes main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
