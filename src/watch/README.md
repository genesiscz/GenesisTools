# 🔄 Watch

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Cross--platform-blue?style=flat-square)
![Dependencies](https://img.shields.io/badge/Dependencies-Minimal-green?style=flat-square)

> **Real-time file monitoring with powerful glob patterns - like `tail -f` on steroids! 🚀**

Watch multiple files across directories, auto-detect new files, and see changes as they happen with beautiful formatting.

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎯 **Glob Patterns** | Watch any files matching patterns like `**/*.{js,ts}` |
| 📡 **Real-time Updates** | See changes instantly as files are modified |
| 🆕 **Auto-discovery** | New files matching patterns are detected automatically |
| 🏠 **Path Expansion** | Full support for `~` home directory expansion |
| ⚡ **Smart Polling** | Configurable intervals with efficient file watching |
| 📊 **Rich Summaries** | Visual directory trees and file listings |
| 🎨 **Beautiful Output** | Color-coded changes with timestamps |

---

## 🚀 Quick Start

```bash
# Watch all TypeScript files
tools watch "src/**/*.ts"

# Watch multiple file types
tools watch "~/projects/**/*.{js,ts,tsx,json}"

# Follow mode (continuous updates)
tools watch "logs/**/*.log" --follow

# Fast polling with more context
tools watch "**/*.md" --seconds 1 --lines 100
```

---

## 🎛️ Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--seconds` | `-s` | Polling interval in seconds | `1` |
| `--verbose` | `-v` | Show detailed file scanning info | `false` |
| `--follow` | `-f` | Continuously follow file changes | `false` |
| `--lines` | `-n` | Number of initial lines to show | `50` |
| `--help` | `-h` | Display help information | - |

---

## 📖 Usage Modes

### 🔍 **Standard Mode** (default)
Shows files ordered by modification time and exits:
```bash
tools watch "src/**/*.js"
# Displays current file contents and exits
```

### 📡 **Follow Mode** (`-f`)
Continuously monitors for changes:
```bash
tools watch "src/**/*.js" -f
# Keeps running and shows updates in real-time
```

---

## 💡 Pro Tips

<details>
<summary><b>🎯 Advanced Patterns</b></summary>

```bash
# Watch specific nested patterns
tools watch "src/**/components/**/*.tsx"

# Exclude patterns with shell features
tools watch "src/**/*.js" | grep -v test

# Watch multiple separate directories
tools watch "{src,lib,test}/**/*.js"
```

</details>

<details>
<summary><b>⚡ Performance Optimization</b></summary>

- Use specific patterns to reduce file scanning
- Adjust `--seconds` based on your needs
- Enable `--verbose` to debug performance issues
- Consider using more specific paths instead of `**`

</details>

---

## 🎨 Output Format

The tool provides rich, color-coded output:

```
📁 WATCHED DIRECTORIES:
   ├─ /home/user/project/src
   ├─ /home/user/project/lib

📁 WATCHED FILES:
   ├─ /home/user/project/src/index.ts
   ├─ /home/user/project/src/utils.ts

📄 NEW FILE: 14:23:45 - src/newfile.ts
┌──────────────────────────────────────────────────────────────────────────────┐
│ console.log('Hello from new file!');                                         │
└──────────────────────────────────────────────────────────────────────────────┘

📝 UPDATED: 14:24:12 - src/index.ts
┌──────────────────────────────────────────────────────────────────────────────┐
│ import { utils } from './utils';                                             │
│ console.log('Updated code here');                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Important Notes

> **🔒 Shell Expansion**: Always wrap glob patterns in quotes to prevent shell expansion:
> ```bash
> ✅ tools watch "src/**/*.js"
> ❌ tools watch src/**/*.js  # Shell expands before tool receives it
> ```

---

## 🛠️ Technical Details

- Built with **chokidar** for robust file watching
- Uses **glob** for powerful pattern matching
- Implements smart buffering for optimal performance
- Supports all major platforms (Windows, macOS, Linux)
