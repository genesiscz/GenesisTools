#!/bin/bash

# Check if bun is installed
if ! command -v bun &> /dev/null; then
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
    exit 1
fi

echo "✅ Bun is installed"

# Check if node_modules exists, if not install dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    bun install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
    echo "✅ Dependencies installed"
else
    echo "✅ Dependencies already installed"
fi

# Get the current directory of the script
CURRENT_DIR="$(pwd)"

# Detect Windows (Git Bash / MSYS2 / Cygwin)
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$OSTYPE" == "cygwin" ]]; then
    IS_WINDOWS=true
fi

SHELL_CONFIG_CHANGED=false

if [ "$IS_WINDOWS" = true ]; then
    # Convert MSYS/Cygwin path to Windows path for setx
    WIN_DIR="$(cygpath -w "$CURRENT_DIR" 2>/dev/null || echo "$CURRENT_DIR")"

    # Set GENESIS_TOOLS_PATH as a persistent user environment variable
    if setx GENESIS_TOOLS_PATH "$WIN_DIR" > /dev/null 2>&1; then
        echo "📝 Set GENESIS_TOOLS_PATH=$WIN_DIR"
    else
        echo "❌ Failed to set GENESIS_TOOLS_PATH via setx"
        exit 1
    fi

    # Add to user PATH if not already present (case-insensitive check)
    CURRENT_PATH="$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'User')" 2>/dev/null | tr -d '\r')"
    if echo "$CURRENT_PATH" | grep -qi "$(echo "$WIN_DIR" | sed 's/\\/\\\\/g')"; then
        echo "✅ $WIN_DIR is already in user PATH"
    else
        NEW_PATH="${CURRENT_PATH:+$CURRENT_PATH;}$WIN_DIR"
        if powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', '$NEW_PATH', 'User')" 2>/dev/null; then
            echo "📝 Added $WIN_DIR to user PATH"
            SHELL_CONFIG_CHANGED=true
        else
            echo "❌ Failed to add to user PATH"
            exit 1
        fi
    fi

    # Also update current session
    export GENESIS_TOOLS_PATH="$CURRENT_DIR"
    export PATH="$CURRENT_DIR:$PATH"

    # Create tools.cmd wrapper for CMD/PowerShell
    TOOLS_CMD="$CURRENT_DIR/tools.cmd"
    cat > "$TOOLS_CMD" << 'CMDEOF'
@echo off
bun run "%~dp0tools" %*
CMDEOF
    echo "✅ Created tools.cmd for CMD/PowerShell"
else
    TOOLS_LINE="export GENESIS_TOOLS_PATH=\"$CURRENT_DIR\""
    EXPORT_LINE="export PATH=\"\$GENESIS_TOOLS_PATH:\$PATH\""

    # Function to add the export line to a shell config file
    add_to_shell_config() {
        local shell_config_file="$1"

        if [ -f "$shell_config_file" ]; then
            # Check if the line already exists in the file
            if grep -q "GENESIS_TOOLS_PATH" "$shell_config_file"; then
                echo "✅ $CURRENT_DIR is already in PATH in $shell_config_file"
            else
                # Append the export line if not found
                echo "$TOOLS_LINE" >> "$shell_config_file"
                echo "$EXPORT_LINE" >> "$shell_config_file"
                echo "📝 Added $CURRENT_DIR to PATH in $shell_config_file"
                SHELL_CONFIG_CHANGED=true
            fi
        else
            # Create the file and add both lines
            echo "$TOOLS_LINE" > "$shell_config_file"
            echo "$EXPORT_LINE" >> "$shell_config_file"
            echo "➕ Created $shell_config_file and added $CURRENT_DIR to PATH"
            SHELL_CONFIG_CHANGED=true
        fi
    }

    # Add to .zshrc
    add_to_shell_config "$HOME/.zshrc"

    # Add to .bashrc
    add_to_shell_config "$HOME/.bashrc"

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
        case "$SHELL" in
            */zsh)  echo "     source ~/.zshrc" ;;
            */bash) echo "     source ~/.bashrc" ;;
            *)      echo "     source your shell config" ;;
        esac
    fi
fi