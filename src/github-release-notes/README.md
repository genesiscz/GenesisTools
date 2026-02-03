# 📋 GitHub Release Notes

![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)
![Markdown](https://img.shields.io/badge/Markdown-000000?style=flat-square&logo=markdown&logoColor=white)

> **Generate beautiful markdown documentation from GitHub release notes**

A command-line tool that fetches release notes from any GitHub repository and generates a clean, formatted markdown document with links to each release.

---

## ✨ Features at a Glance

| Feature | Description |
|---------|-------------|
| 📄 **Markdown Output** | Clean, formatted markdown with release links |
| 🔗 **Flexible Input** | Accepts `owner/repo` or full GitHub URLs |
| 📊 **Pagination** | Fetches multiple pages of releases automatically |
| 🔢 **Limit Support** | Control how many releases to include |
| 🔀 **Sort Order** | Newest-first (default) or oldest-first |
| 🔐 **Token Support** | Use GITHUB_TOKEN to avoid rate limits |
| 📁 **File or Stdout** | Output to file or pipe to other tools |

---

## 🚀 Quick Start

```bash
# Fetch all releases to a file
tools github-release-notes facebook/react releases.md

# Fetch latest 10 releases to stdout
tools github-release-notes facebook/react --limit 10

# Use full GitHub URL
tools github-release-notes https://github.com/vercel/next.js changelog.md

# Oldest releases first
tools github-release-notes software-mansion/react-native-reanimated notes.md --oldest
```

---

## 📋 Options Reference

| Option | Description | Default |
|--------|-------------|---------|
| `<repo>` | Repository in `owner/repo` format or full GitHub URL | required |
| `[output]` | Output file path (omit for stdout) | stdout |
| `--limit <n>` | Maximum number of releases to fetch | all (up to 500) |
| `--oldest` | Sort from oldest to newest | `false` (newest first) |
| `-?`, `--help-full` | Show extended help message | - |

---

## 🔐 Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub personal access token to avoid API rate limits |

### Setting up GITHUB_TOKEN

```bash
# Add to your shell profile (~/.zshrc or ~/.bashrc)
export GITHUB_TOKEN=your_github_token

# Or set temporarily for one command
GITHUB_TOKEN=your_token tools github-release-notes owner/repo output.md
```

Without a token, GitHub limits API requests to 60/hour. With a token, this increases to 5,000/hour.

---

## 💡 Real-World Examples

<details>
<summary><b>🔧 Common Use Cases</b></summary>

### 📦 Generate Changelog for Documentation
```bash
# Create a full changelog for your project's docs
tools github-release-notes your-org/your-repo CHANGELOG.md
```

### 🔍 Review Recent Changes
```bash
# Quick look at last 5 releases
tools github-release-notes lodash/lodash --limit 5
```

### 📈 Historical Analysis
```bash
# Get releases in chronological order for analysis
tools github-release-notes microsoft/TypeScript typescript-history.md --oldest --limit 50
```

### 🤖 CI/CD Integration
```bash
# Generate release notes as part of documentation build
GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} \
  tools github-release-notes $REPO_OWNER/$REPO_NAME docs/releases.md
```

</details>

---

## 📄 Output Format

The generated markdown includes:

- **Header** with repository name and link
- **Generation date** for reference
- **Release sections** with:
  - Version tag linked to GitHub release page
  - Publication date
  - Full release body content
  - Horizontal separators between releases

Example output structure:

```markdown
# Release Notes: owner/repo

This document contains the release notes for [owner/repo](https://github.com/owner/repo).

Generated on: 2024-01-15

## [v2.0.0](https://github.com/owner/repo/releases/tag/v2.0.0) - 2024-01-10

Release notes content here...

---

## [v1.0.0](https://github.com/owner/repo/releases/tag/v1.0.0) - 2023-12-01

Initial release content...
```

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| **Rate limit exceeded** | Set `GITHUB_TOKEN` environment variable |
| **Repository not found** | Check spelling, ensure repo is public or token has access |
| **Empty output** | Repository may have no releases (only tags) |
| **Invalid format** | Use `owner/repo` or full `https://github.com/...` URL |
