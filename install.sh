#!/bin/bash

# Get the current directory of the script
CURRENT_DIR="$(pwd)"
EXPORT_LINE="export PATH=\"$CURRENT_DIR:\$PATH\""

# Function to add the export line to a shell config file
add_to_shell_config() {
    local shell_config_file="$1"

    if [ -f "$shell_config_file" ]; then
        # Check if the line already exists in the file
        if grep -q "export PATH=\"$CURRENT_DIR:\$PATH" "$shell_config_file" && grep -q "$CURRENT_DIR" "$shell_config_file"; then
            echo "✅ $CURRENT_DIR is already in PATH in $shell_config_file"
        else
            # Append the export line if not found
            echo "$EXPORT_LINE" >> "$shell_config_file"
            echo "📝 Added $CURRENT_DIR to PATH in $shell_config_file"
        fi
    else
        # Create the file and add the export line if the file does not exist
        echo "$EXPORT_LINE" > "$shell_config_file"
        echo "➕ Created $shell_config_file and added $CURRENT_DIR to PATH"
    fi
}

# Add to .zshrc
add_to_shell_config "$HOME/.zshrc"

# Add to .bashrc
add_to_shell_config "$HOME/.bashrc"

echo "🎉 Setup complete. Please restart your terminal or run 'source ~/.zshrc' and/or 'source ~/.bashrc' for the changes to take effect."