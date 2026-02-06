# Git Commit

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![AI](https://img.shields.io/badge/AI-Gemini%202.0%20Flash%20Lite-blue?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Cross--platform-green?style=flat-square)

> **AI-powered commit message generator using Google Gemini via OpenRouter**

Generate meaningful commit messages from your staged changes with AI assistance. Select from multiple suggestions and optionally push in one flow.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **AI-Generated Messages** | Uses Google Gemini 2.0 Flash Lite via OpenRouter |
| **Multiple Suggestions** | Generates 4 commit message options to choose from |
| **Conventional Commits** | Follows conventional commit format automatically |
| **Detailed Mode** | Optional body text with bullet point explanations |
| **Push Integration** | Optionally push after committing |
| **Stage All** | Stage all changes before committing with one flag |

---

## Quick Start

```bash
# Generate commit message for staged changes
tools git-commit

# Stage all changes and generate commit message
tools git-commit --stage

# Generate detailed messages with body text
tools git-commit --detail

# Combine options
tools git-commit -s -d
```

---

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--stage` | `-s` | Stage all changes before committing | `false` |
| `--detail` | `-d` | Generate detailed messages with body | `false` |
| `--verbose` | `-v` | Enable verbose logging | `false` |
| `--help` | `-h` | Display help information | - |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter authentication |

Get your API key at [openrouter.ai](https://openrouter.ai/)

---

## Usage Flow

```
1. Stage changes (or use --stage)
           ↓
2. AI analyzes the diff
           ↓
3. Select from 4 suggestions
           ↓
4. Commit is created
           ↓
5. Optionally push changes
```

---

## Examples

<details>
<summary><b>Standard Mode</b></summary>

```bash
# Stage your changes first
git add src/feature.ts

# Generate commit messages
tools git-commit

# Output:
# 📊 Getting diff of staged changes...
# 🤖 Generating commit messages with AI...
# ? Choose a commit message:
#   > feat: add user authentication feature
#     fix: resolve login timeout issue
#     refactor: simplify auth flow logic
#     chore: update authentication module
```

</details>

<details>
<summary><b>Detailed Mode</b></summary>

```bash
tools git-commit --detail

# Output includes body text:
# ? Choose a commit message:
#   > feat: add user authentication feature
#       - Added JWT token validation
#       - Implemented session management
#       - Added login/logout endpoints
```

</details>

<details>
<summary><b>Stage and Commit</b></summary>

```bash
# Stage all changes and commit in one command
tools git-commit --stage

# Output:
# 📦 Staging all changes...
# 📊 Getting diff of staged changes...
# 🤖 Generating commit messages with AI...
```

</details>

---

## Important Notes

> **API Key Required**: You must set the `OPENROUTER_API_KEY` environment variable before using this tool.
> ```bash
> export OPENROUTER_API_KEY="your-api-key-here"
> ```

> **Staged Changes Only**: Without `--stage`, the tool only considers already staged changes. Use `git add` first or pass `--stage` to include all modifications.

---

## Technical Details

- Built with **Vercel AI SDK** for structured AI responses
- Uses **@openrouter/ai-sdk-provider** for OpenRouter integration
- **Zod** schema validation ensures consistent AI output
- Generates exactly 4 commit message suggestions per run
