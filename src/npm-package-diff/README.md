# NPM Package Diff

A powerful command-line tool for comparing files between different versions of npm packages. It creates temporary directories, installs the specified package versions, watches for file changes during installation, and shows beautiful diffs between matching files with multiple output formats.

## Features

- 🎨 **Beautiful Terminal Output**: Colored diffs with syntax highlighting
- 📊 **Multiple Output Formats**: Terminal, unified diff, HTML, JSON, side-by-side
- 🔍 **Smart Filtering**: Include/exclude files using glob patterns
- 📈 **Statistics & Analytics**: File counts, size comparisons, change summaries
- ⚡ **Performance**: Parallel package installation, efficient file watching
- 🛠️ **Highly Configurable**: CLI options, config files, environment variables
- 🎯 **Integration Ready**: Supports output redirection, CI/CD pipelines
- 🌈 **Delta Support**: Optional integration with delta for even prettier diffs

## Usage

```bash
tools npm-package-diff <package-name> <version1> <version2> [options]
```

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--filter` | `-f` | Glob pattern to include files | `**/*.d.ts` |
| `--exclude` | `-e` | Glob pattern to exclude files | - |
| `--output` | `-o` | Output file path | console |
| `--format` | `-F` | Output format (see below) | `terminal` |
| `--patch` | `-p` | Generate patch file | - |
| `--verbose` | `-v` | Enable verbose logging | `false` |
| `--silent` | `-s` | Suppress output except errors | `false` |
| `--stats` | - | Show statistics summary | `false` |
| `--sizes` | - | Compare file sizes | `false` |
| `--line-numbers` | - | Show line numbers | `true` |
| `--word-diff` | - | Show word-level differences | `false` |
| `--side-by-side` | - | Side-by-side view | `false` |
| `--context` | - | Context lines in diff | `3` |
| `--config` | `-c` | Path to config file | `.npmpackagediffrc` |
| `--use-delta` | - | Use delta for output | `false` |
| `--delta-theme` | - | Delta theme (light/dark) | `auto` |

## Output Formats

- **terminal**: Colored diff output in the terminal (default)
- **unified**: Standard unified diff format (can be used as .patch)
- **html**: Interactive HTML with syntax highlighting
- **json**: Structured JSON with detailed changes
- **side-by-side**: Terminal side-by-side comparison

## Examples

### Basic Usage
```bash
# Compare TypeScript definitions between React versions
tools npm-package-diff react 18.0.0 18.2.0

# Compare all JavaScript files
tools npm-package-diff lodash 4.17.20 4.17.21 --filter="**/*.js"
```

### Generate Patch File
```bash
# Create a unified diff patch
tools npm-package-diff express 4.17.0 4.18.0 --patch express.patch

# Or use the unified format
tools npm-package-diff express 4.17.0 4.18.0 --format unified -o express.patch
```

### Create HTML Report
```bash
# Generate an interactive HTML diff
tools npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html

# With side-by-side view
tools npm-package-diff vue 3.2.0 3.3.0 --format html --side-by-side -o vue-diff.html
```

### Advanced Usage
```bash
# Show statistics and size comparison
tools npm-package-diff axios 0.27.0 1.0.0 --stats --sizes

# Use delta for beautiful terminal output
tools npm-package-diff typescript 4.9.0 5.0.0 --use-delta

# Exclude test files and show word-level diff
tools npm-package-diff jest 28.0.0 29.0.0 --exclude="**/*.test.js" --word-diff

# JSON output with statistics
tools npm-package-diff webpack 4.46.0 5.88.0 --format json -o webpack-diff.json

# Redirect output to file (strips ANSI colors automatically)
tools npm-package-diff react 17.0.0 18.0.0 > react-diff.txt
```

## Configuration File

Create a `.npmpackagediffrc` file in your project root:

```json
{
  "filter": "**/*.{js,ts,jsx,tsx}",
  "exclude": "**/{test,tests,__tests__}/**",
  "format": "terminal",
  "lineNumbers": true,
  "wordDiff": false,
  "context": 3,
  "stats": true,
  "sizes": true,
  "useDelta": false
}
```

## How It Works

1. Creates temporary directories for each package version
2. Sets up file watchers to monitor additions during installation
3. Installs both package versions in parallel using npm/yarn
4. Collects metadata about all added files
5. Filters files based on include/exclude patterns
6. Compares matching files and generates diffs
7. Outputs results in the specified format
8. Cleans up temporary directories

## Integration with CI/CD

The tool is designed to work well in CI/CD pipelines:

```bash
# Exit with non-zero code if differences found
tools npm-package-diff mypackage 1.0.0 2.0.0 --format json -o diff.json
if [ -s diff.json ]; then
  echo "Differences found!"
  exit 1
fi

# Generate HTML report for artifacts
tools npm-package-diff mypackage $OLD_VERSION $NEW_VERSION \
  --format html \
  --output reports/package-diff.html \
  --stats \
  --sizes
```

## Tips

1. **Performance**: Use specific filters to reduce comparison time
2. **Large Packages**: Increase context lines for better understanding
3. **Binary Files**: These are detected and skipped automatically
4. **Delta Integration**: Install delta separately for enhanced output
5. **Output Redirection**: ANSI colors are automatically stripped

## Troubleshooting

- **Installation Fails**: Ensure npm/yarn is properly configured
- **No Differences Found**: Check your filter patterns
- **Out of Memory**: Use more specific filters or compare fewer files
- **Delta Not Working**: Install delta separately: `brew install git-delta`

## License

MIT