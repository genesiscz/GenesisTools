# watch

A command-line tool that watches files matching a glob pattern and displays changes in real-time, similar to `tail -f` but for multiple files including those created after the watch has started.

## Features

- Watch files matching any glob pattern (e.g., `~/projects/**/*.{js,ts,tsx}`)
- Display file content in real-time as files are created or modified
- Automatically detect new files that match the pattern
- Show file additions, modifications, and removals
- Support for tilde expansion (`~`) for home directory
- Configurable polling interval
- Follow mode to tail files continuously
- Shows a summary of scanned directories and matched files

## Usage

```bash
tools watch [glob-pattern] [options]
```

### Options

- `--seconds`, `-s`: Polling interval in seconds (default: 1)
- `--verbose`, `-v`: Enable verbose logging to see more detailed information about which files are being scanned
- `--follow`, `-f`: Follow mode that only shows new content (like tail -f)
- `--lines`, `-n`: Number of lines to display from each file (default: 50)
- `--help`, `-h`: Show help information

### Examples

Watch all TypeScript files in the `src` directory and its subdirectories:
```bash
tools watch "src/**/*.ts"
```

Watch multiple file types in your home directory with verbose logging:
```bash
tools watch "~/projects/**/*.{js,ts,tsx}" -v -n 100
```

Only show new changes to files (follow mode):
```bash
tools watch "src/**/*.ts" -f
```

Use a faster polling interval (1 second) with follow mode:
```bash
tools watch "src/**/*.ts" --seconds 1 -f
```

## How It Works

The tool uses the `chokidar` library to watch for file changes based on the provided glob pattern. When files are added, modified, or removed, it displays the changes in the terminal in real-time.

- New or modified files: The tool shows the timestamp, file path, and the new content of the file
- Removed files: The tool shows a notification that the file has been removed
- Scanned directories: The tool shows a list of all directories being scanned
- Matched files: The tool shows a list of all files that match the pattern

The tool can be stopped by pressing `Ctrl+C`. 