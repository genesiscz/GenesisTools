# 🎨 NPM Package Diff

![npm](https://img.shields.io/badge/npm-CB3837?style=flat-square&logo=npm&logoColor=white)
![yarn](https://img.shields.io/badge/Yarn-2C8EBB?style=flat-square&logo=yarn&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white)
![bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)

> **🚀 Lightning-fast, beautiful diffs between NPM package versions**

A powerful command-line tool that creates temporary directories, installs package versions in parallel, reads every installed file once the installs finish, and shows beautiful diffs with multiple output formats.

---

## ✨ Features at a Glance

| Feature | Description |
|---------|-------------|
| 🎨 **Beautiful Output** | Colored terminal diffs with syntax highlighting |
| 📊 **Multiple Formats** | Terminal, unified diff, HTML, JSON, side-by-side |
| 🔍 **Smart Filtering** | Include/exclude files using glob patterns |
| 📈 **Rich Analytics** | File counts, size comparisons, change summaries |
| ⚡ **High Performance** | Parallel installation, one file walk after it |
| 🛠️ **Highly Configurable** | CLI options, config files, environment variables |
| 🎯 **CI/CD Ready** | Exit codes, JSON output, automated workflows |
| 🌈 **Delta Integration** | GitHub-style diffs with delta support |

---

## 🚀 Quick Start

```bash
# Compare TypeScript definitions
tools npm-package-diff react 18.0.0 18.2.0

# Compare with beautiful side-by-side view
tools npm-package-diff lodash 4.17.20 4.17.21 --format side-by-side

# Generate an HTML report
tools npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html
```

---

## 📋 Complete Options Reference

<details>
<summary><b>🎛️ All Available Options</b></summary>

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--filter` | `-f` | Glob pattern to include files | `**/*.d.ts` |
| `--exclude` | `-e` | Glob pattern to exclude files | - |
| `--output` | `-o` | Output file path | console |
| `--format` | `-F` | Output format (see formats below) | `terminal` |
| `--patch` | `-p` | Generate patch file | - |
| `--verbose` | `-v` | Enable verbose logging | `false` |
| `--silent` | `-s` | Suppress output except errors | `false` |
| `--stats` | - | Show statistics summary | `false` |
| `--sizes` | - | Compare file sizes | `false` |
| `--line-numbers` | - | Show line numbers | `true` |
| `--word-diff` | - | Show word-level differences | `false` |
| `--side-by-side` | - | Side-by-side view | `false` |
| `--context` | - | Context lines in diff | `10` |
| `--config` | `-c` | Path to config file | `.npmpackagediffrc` |
| `--use-delta` | - | Use delta for output | `false` |
| `--delta-theme` | - | Delta theme (light/dark) | `auto` |
| `--timeout` | - | Installation timeout (ms) | `120000` |
| `--npmrc` | - | Path to .npmrc file | - |
| `--package-manager` | `-m` | Package manager to use | `auto` |
| `--paging` | - | Enable terminal pagination | `false` |
| `--keep` | `-k` | Keep temporary directories | `false` |

</details>

---

## 🎨 Output Formats

| Format | Description | Best For |
|--------|-------------|----------|
| 🖥️ **terminal** | Colored diff with syntax highlighting | Quick reviews |
| 📄 **unified** | Standard patch format | Git patches |
| 🌐 **html** | Interactive web page with toggles | Sharing & reports |
| 📊 **json** | Structured data | Automation & CI |
| ↔️ **side-by-side** | Split-screen comparison | Detailed analysis |

---

## 💡 Real-World Examples

<details>
<summary><b>🔧 Common Use Cases</b></summary>

### 📦 Breaking Change Detection
```bash
# Check for breaking changes in a major version bump
tools npm-package-diff express 4.18.0 5.0.0 --stats --sizes
```

### 🔍 Security Audit Trail
```bash
# Track changes in security-critical packages
tools npm-package-diff jsonwebtoken 8.5.1 9.0.0 --format html -o security-audit.html
```

### 🤖 CI/CD Integration
```bash
# Automated checks in CI pipeline
tools npm-package-diff mypackage $OLD_VERSION $NEW_VERSION --format json -o diff.json
if [ -s diff.json ]; then
  echo "Changes detected!"
  exit 1
fi
```

### 📈 Migration Guide Generation
```bash
# Create a detailed migration guide
tools npm-package-diff typescript 4.9.0 5.0.0 \
  --format html \
  --stats \
  --sizes \
  --output migration-guide.html
```

</details>

---

## ⚙️ Configuration

<details>
<summary><b>📝 Configuration File Example</b></summary>

Create a `.npmpackagediffrc` file in your project:

```json
{
  "filter": "**/*.{js,ts,jsx,tsx}",
  "exclude": "**/{test,tests,__tests__}/**",
  "format": "terminal",
  "lineNumbers": true,
  "wordDiff": false,
  "context": 10,
  "stats": true,
  "sizes": true,
  "timeout": 180000,
  "packageManager": "pnpm",
  "npmrc": "./.npmrc",
  "paging": true,
  "useDelta": false
}
```

</details>

---

## 🚦 How It Works

```mermaid
graph LR
    A[Start] --> B[Create Temp Dirs]
    B --> D[Install Packages]
    D --> E[Read Installed Files]
    E --> F[Filter Files]
    F --> G[Generate Diffs]
    G --> H[Format Output]
    H --> I[Cleanup]
```

1. **🏗️ Setup** - Creates isolated temporary directories
2. **📦 Install** - Parallel package installation
3. **📊 Analyze** - Reads every installed file (symlinks followed, cycles skipped) and filters them; when the filter matches nothing it says so
4. **🎨 Output** - Generates beautiful, formatted diffs
5. **🧹 Cleanup** - Removes temporary files (unless `--keep`)

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| **Installation fails** | Check npm/yarn config, use `--npmrc` for auth |
| **No differences found** | Verify filter patterns with `--verbose` |
| **Out of memory** | Use specific filters to reduce file count |
| **Delta not working** | Install separately: `brew install git-delta` |
