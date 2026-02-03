# ⚛️ React Compiler Debug

![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Babel](https://img.shields.io/badge/Babel-F9DC3E?style=flat-square&logo=babel&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)

> **🔬 Inspect what babel-plugin-react-compiler generates from your React components**

A debugging tool that shows the exact output of React Compiler, helping you understand memoization decisions, cache slot usage, and why components may or may not be optimized.

---

## ✨ Features at a Glance

| Feature | Description |
|---------|-------------|
| 📁 **Multiple Inputs** | File path, inline code, or stdin |
| 🎯 **React Version Targets** | Support for React 17, 18, and 19 |
| 🔍 **Memoization Analysis** | Shows whether components are memoized and cache slot count |
| 📊 **Compilation Modes** | infer, all, annotation, or syntax modes |
| 📋 **Clipboard Support** | Copy output directly to clipboard |
| 🐛 **Verbose Mode** | See internal compiler events for debugging |
| 📝 **Side-by-side View** | Show original and compiled code together |

---

## 🚀 Quick Start

```bash
# Compile a file
tools react-compiler-debug src/components/Button.tsx

# Compile inline code
tools react-compiler-debug --code "const Foo = () => <div>{props.name}</div>"

# Pipe from stdin
cat MyComponent.tsx | tools react-compiler-debug --stdin

# Show original + compiled side by side
tools react-compiler-debug MyComponent.tsx --with-original
```

---

## 📋 Options Reference

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--code` | `-c` | Compile inline code snippet | - |
| `--stdin` | `-s` | Read code from stdin | `false` |
| `--verbose` | `-v` | Show compiler events | `false` |
| `--clipboard` | - | Copy output to clipboard | `false` |
| `--target` | `-t` | React version target (17, 18, 19) | `19` |
| `--mode` | `-m` | Compilation mode | `infer` |
| `--with-original` | - | Include original code before compiled | `false` |

### Compilation Modes

| Mode | Description |
|------|-------------|
| `infer` | Compiler decides what to optimize (default) |
| `all` | Compile all components unconditionally |
| `annotation` | Only compile components with `'use memo'` directive |
| `syntax` | Only transform syntax, no memoization |

---

## 💡 Example Output

### Input
```tsx
const Greeting = ({ name }) => {
  const message = `Hello, ${name}!`;
  return <div className="greeting">{message}</div>;
};
```

### Compiled Output
```tsx
// ====== COMPILED ======
import { c as _c } from "react/compiler-runtime";
const Greeting = ({
  name
}) => {
  const $ = _c(4);
  let message;
  if ($[0] !== name) {
    message = `Hello, ${name}!`;
    $[0] = name;
    $[1] = message;
  } else {
    message = $[1];
  }
  let t0;
  if ($[2] !== message) {
    t0 = <div className="greeting">{message}</div>;
    $[2] = message;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
};

// ====== SUMMARY ======
// Memoized: Yes
// Cache slots used: 4
```

---

## 🎯 Real-World Use Cases

### Debug Why a Component Isn't Memoized
```bash
# Check if compiler optimizes your component
tools react-compiler-debug src/components/ExpensiveList.tsx --verbose
```

### Compare Different React Targets
```bash
# See how output differs between React versions
tools react-compiler-debug MyComponent.tsx --target 18
tools react-compiler-debug MyComponent.tsx --target 19
```

### Quick Inline Testing
```bash
# Test a pattern quickly
tools react-compiler-debug -c "const C = ({ items }) => items.map(i => <li key={i}>{i}</li>)"
```

### Copy for Documentation
```bash
# Copy compiled output for docs or issues
tools react-compiler-debug MyComponent.tsx --with-original --clipboard
```

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| **"babel-plugin-react-compiler not found"** | Run GenesisTools install: `bun install` in GenesisTools root |
| **"Compilation failed"** | Check for syntax errors; use `--verbose` for details |
| **Component not memoized** | Compiler may skip due to patterns it cannot optimize |
| **Different output than expected** | Try `--mode all` to force compilation |
