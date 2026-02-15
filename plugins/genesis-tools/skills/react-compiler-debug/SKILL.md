---
name: genesis-tools:react-compiler-debug
description: Debug and inspect React Compiler (babel-plugin-react-compiler) output. Use when user asks to see what React Compiler generates, debug memoization issues, understand why a component isn't being optimized, or compare original vs compiled code. Triggers on "react compiler", "compiler output", "see compiled", "memoization debug", "why isn't this memoized".
---

# React Compiler Debug

Inspect what `babel-plugin-react-compiler` generates from React components.

## Prerequisites

This tool requires GenesisTools to be **fully installed** (not just the plugin).

If you see `Cannot find package 'babel-plugin-react-compiler'`:

```bash
# Check if tools command exists
which tools

# If not found, use /genesis-tools:setup to install the full toolkit
```

**The `tools` command must be in your PATH** for this to work. The plugin alone doesn't include the babel dependencies.

## Quick Start

```bash
# Compile a file and see output
tools react-compiler-debug <file.tsx>

# Compile inline code
tools react-compiler-debug --code "const Foo = ({ x }) => <div>{x}</div>"

# Verbose mode (shows compiler events)
tools react-compiler-debug -v <file.tsx>

# Output to clipboard
tools react-compiler-debug <file.tsx> --clipboard

# Show original + compiled (for file input only)
tools react-compiler-debug <file.tsx> --with-original
```

> **Tip for skill usage:** When compiling a file and you haven't already read its content, use `--with-original` to see both the original and compiled versions. This flag is ignored for `--code` input.

## When to Use

- **Debug memoization**: See if/how React Compiler optimizes a component
- **Compare output**: Understand the transformation applied
- **Diagnose issues**: Find why a component isn't being optimized
- **Learn**: Understand what useMemoCache and other compiler primitives do

## Compiler Options Reference

Key options from `babel-plugin-react-compiler`:

| Option | Values | Description |
|--------|--------|-------------|
| `compilationMode` | `infer` (default), `all`, `annotation`, `syntax` | Which functions to compile |
| `target` | `17`, `18`, `19` | React version target |
| `panicThreshold` | `none` (default), `critical_errors`, `all_errors` | Error handling |

## Reading the Output

The compiled output uses React Compiler primitives:

- `useMemoCache(n)` - Creates a cache with n slots
- `$[0]`, `$[1]`, etc. - Cache slot access
- `Symbol.for("react.memo_cache_sentinel")` - Cache invalidation marker

## Example

Input:
```tsx
const Greeting = ({ name }) => <h1>Hello, {name}!</h1>;
```

Output (simplified):
```tsx
function Greeting(t0) {
  const $ = useMemoCache(2);
  const { name } = t0;
  let t1;
  if ($[0] !== name) {
    t1 = <h1>Hello, {name}!</h1>;
    $[0] = name;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}
```

The compiler memoizes the JSX based on `name` prop changes.

## Common Bail-out Patterns

When the compiler skips optimization, check for these common causes:

| Pattern | Why it bails out | Fix |
|---------|-----------------|-----|
| Mutable ref in render | `ref.current = x` is validated by `validateNoRefAccessInRender` | Move to `useEffect` or event handler |
| setState in render | `setState()` during render validated by `validateNoSetStateInRender` | Move to event handler or `useEffect` |
| JSX inside try/catch | `validateNoJSXInTryStatement` errors — use error boundaries instead | Wrap component in `<ErrorBoundary>`, remove try/catch |
| `try` without `catch` | Lowering TODO — compiler can't build HIR for incomplete try | Add explicit `catch` block |
| `try...finally` | Lowering TODO — finalizer clause not yet supported | Restructure to `try/catch` or extract to utility |
| `throw` inside try/catch | Lowering TODO — ThrowStatement in try/catch not handled | Extract throwing logic to a separate function |
| Inline `class` declaration | `UnsupportedSyntax` — class inside component not supported | Move class outside component/hook |
| `for-await` loops | Lowering TODO — async iteration not yet supported | Use `Promise.all()` or manual iteration |
| `with` statement | `UnsupportedSyntax` — deprecated JS syntax | Remove `with`, use explicit property access |

> **Debugging tip:** Add `"use no memo"` at the top of a function body to temporarily opt it out of compilation and confirm the compiler is involved in an issue. Source: [BuildHIR.ts](https://github.com/facebook/react/blob/main/compiler/packages/babel-plugin-react-compiler/src/HIR/BuildHIR.ts), [ValidateNoJSXInTryStatement.ts](https://github.com/facebook/react/blob/main/compiler/packages/babel-plugin-react-compiler/src/Validation/ValidateNoJSXInTryStatement.ts)
