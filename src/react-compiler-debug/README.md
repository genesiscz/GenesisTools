# tools react-compiler-debug

Shows the code that `babel-plugin-react-compiler` makes from a React component, so you can see what it memoizes,
how many cache slots it uses, and why a component was or was not optimized. It runs the compiler alone, without your
project's Babel setup, and prints the result in a form that is easier to read.

## Quick start

```bash
# Compile a file and print the result
tools react-compiler-debug src/components/Button.tsx

# Compile an inline snippet
tools react-compiler-debug --code "const Foo = ({ x }) => <div>{x}</div>"

# Read the code from stdin
cat src/components/Button.tsx | tools react-compiler-debug --stdin

# Print the input above the output, and copy both to the clipboard
tools react-compiler-debug src/components/Button.tsx --with-original --clipboard

# See why a component was skipped: compiler events and error stacks
tools react-compiler-debug src/components/ExpensiveList.tsx -v
```

## Command

The tool has one command and no subcommands. Give it a file, `--code` or `--stdin`. When you give more than one,
`--code` wins over `--stdin`, and `--stdin` wins over the file. With no input it prints a short usage and exits 1.

| Flag | Default | What it does |
|------|---------|--------------|
| `[file]` | | File to compile |
| `-c, --code <code>` | | Compile an inline snippet |
| `-s, --stdin` | off | Read the code from stdin |
| `-t, --target <version>` | `19` | React version target: `17`, `18` or `19` |
| `-m, --mode <mode>` | `infer` | Which functions to compile (see below) |
| `--with-original` | off | Print the input before the output |
| `--raw` | off | Print the compiler output as it is |
| `--clipboard` | off | Also copy the output to the clipboard |
| `-v, --verbose` | off | Print compiler events and error stacks |
| `--readme` | | Print this README and exit |

- `--with-original` works with a file and with `--stdin`. It is ignored with `--code`.
- `--clipboard` copies the text without colors, prints `Output copied to clipboard!`, and still prints the output.
- The tool does not check `--target` or `--mode` itself. The compiler rejects an unknown target with
  `Not a valid target`, which the tool prints as a compilation error. An unknown mode fails with
  `Compilation error: <file>: Unexpected compilationMode \`<mode>\``.

### Compilation modes

These are the plugin's own modes (`babel-plugin-react-compiler` 1.0.0).

| Mode | What the compiler compiles |
|------|----------------------------|
| `infer` | Functions named like a component or a hook that also create JSX or call a hook |
| `all` | Every top-level function. Nested functions are skipped. |
| `annotation` | Only functions with a `"use memo"` (or older `"use forget"`) directive |
| `syntax` | Only Flow `component` and `hook` declarations |

- A function whose block body starts with `"use memo"` is compiled in every mode.
- `"use no memo"` opts a function out. Use it to prove that the compiler causes a bug.
- The tool parses TypeScript, not Flow. In `syntax` mode it therefore compiles only the `"use memo"` functions.

### Targets

`--target 19` imports the cache helper from `react/compiler-runtime`. `--target 17` and `--target 18` import it from
the `react-compiler-runtime` package, which your app then needs at runtime. The tool only prints the import, so you do
not need that package to compile here. With 17 and 18 the summary says `Memoized: No` even when a function compiled
(see [Reading the output](#reading-the-output)). To compare the two:

```bash
tools react-compiler-debug src/components/Button.tsx --target 18
tools react-compiler-debug src/components/Button.tsx --target 19
```

Input that already imports `c` from the runtime is skipped by the compiler, but the summary still says
`Memoized: Yes`, because the import text is in the output.

## Reading the output

The output has up to three sections:

1. `// ====== ORIGINAL ======`: your input, only with `--with-original`.
2. `// ====== COMPILED ======`: the compiled file, or the compilation error.
3. `// ====== SUMMARY ======`: `Memoized: Yes` or `No`, and `Cache slots used: N` when it is Yes.

Without `--raw`, a readability pass rewrites the compiled code:

- `t0` becomes `props` when the component is an arrow function assigned to a variable with a capitalized name, and
  its one parameter is `t0`.
- A `const name = t3;` line is removed, and `t3` is renamed to `name` everywhere. When that variable is stored in a
  cache slot, its `let` line gets `// 📦 memoized`.
- A `$[N] === Symbol.for("react.memo_cache_sentinel")` check gets `// first render`. That branch runs only on the
  first render.
- `const $ = _c(N);` gets `// cache: [0=name, 1=..., ...]`: what the first five slots store.

If the readability pass fails, the tool prints the raw output instead. It prints the reason only with `-v`.

An abridged sketch for `const Greeting = ({ name }) => <h1>Hello, {name}!</h1>;`. The exact code depends on the
compiler version and on `NODE_ENV`. With `NODE_ENV=development` the compiler adds a cache-reset block keyed by a hash
of the source, so `_c(N)` is one larger, the slot numbers shift by one and `Cache slots used` grows. The sketch is the
output with `NODE_ENV=production`.

```tsx
// ====== COMPILED ======
import { c as _c } from "react/compiler-runtime";
const Greeting = props => {
  const $ = _c(2); // cache: [0=name, 1=t1]
  const { name } = props;
  let t1;
  if ($[0] !== name) {
    t1 = <h1>Hello, {name}!</h1>;
    $[0] = name;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
};

// ====== SUMMARY ======
// Memoized: Yes
// Cache slots used: 4
```

Read the summary with care:

- `Memoized: Yes` means the compiled text contains `react/compiler-runtime` or `useMemoCache`. It says that at least
  one function in the file compiled, not that every component did. Look for `_c(` above each function.
- `Cache slots used` counts every `$[N]` in the text, reads and writes, across the whole file. It is larger than the
  real slot count. The real count of one function is the `N` in its `const $ = _c(N);`. In the sketch above, two
  slots show as 4.
- The renames use one table for the whole file. With several components in one file, a name can come from another
  component. The `cache: [...]` comment is also built from the whole file, so each `_c(N)` line shows the same merged
  list. Use `--raw` when the exact names matter.

## How it works

- The tool runs Babel in this process with two pieces only: `@babel/preset-typescript` and the React Compiler plugin.
  It ignores your `babel.config.js` and `.babelrc`, so project plugins (module resolvers, worklets) do not run, and
  compiler options from your project config do not apply. Only `--target` and `--mode` can be set. The tool has no
  way to pass other compiler options such as `panicThreshold`, `environment` or `sources`.
- Babel resolves `@babel/preset-typescript` from the current directory, so the tool uses your project's copy and
  fails where none is installed. Many SWC or esbuild projects have none. Run the tool from a project that has it, or
  from the GenesisTools checkout.
- A file whose absolute path contains `node_modules` is never compiled: the plugin skips such files by default, with
  no error. See Troubleshooting.
- It always uses the `babel-plugin-react-compiler` from the GenesisTools checkout
  (`<GenesisTools>/node_modules/babel-plugin-react-compiler`, `^1.0.0` in `package.json`), not your project's copy.
  Your build can differ if your project pins another version.
- Every input is parsed as TSX, whatever its extension. A `.ts` file with an angle-bracket cast (`<Foo>value`) or a
  generic arrow function (`<T>(x: T) => x`) fails to parse. Write `value as Foo` and `<T,>(x: T) => x` instead.
- The tool passes `target`, `compilationMode` and, with `-v`, a logger to the plugin. It does not set
  `panicThreshold`, so the plugin default `none` applies: a function the compiler cannot handle is left as it was,
  with no error. Only `-v` shows why.
- With `-v`, each compiler event (`CompileSuccess`, `CompileSkip`, `CompileError`, `PipelineError` and others) prints
  as `[Compiler Event] <file> <JSON>` before the output.
- The tool has no config file and stores no data. It writes one `Compiling` line (file, target, mode) to the
  GenesisTools day log, `~/.genesis-tools/logs/<date>.log`, and the same line goes to stderr on every run. It makes no
  network calls and costs nothing.

## For agents

- The output is plain text on stdout. There is no `--json`. Use `--raw` when you parse the code.
- Exit codes: 1 for no input, a missing file (`File not found: <path>`) or an unexpected error. A compilation error
  exits 0: the text `Compilation error: <message>` is in the output. A `Dependency Error:` line also exits 0.
  Check for both strings.
- stderr also carries the `Compiling` line and the `-v` events. Read stdout only.
- When you have not read the file yet, add `--with-original` to get the source and the result in one call.
- The genesis-tools plugin skill `gt:react-compiler-debug`
  ([SKILL.md](../../plugins/genesis-tools/skills/react-compiler-debug/SKILL.md)) holds a table of common bail-out
  patterns (refs read in render, `setState` in render, JSX in `try`) with their fixes.

## Troubleshooting

- **`Dependency Error: babel-plugin-react-compiler not found.`** The text names the wrong package. Babel could not
  find `@babel/preset-typescript` from the current directory. Run the tool from a project that has it, or `cd` into
  the GenesisTools checkout and pass an absolute file path, `--stdin` or `--code`. The tool suggests `/gt:setup`.
- **`Compilation error: Could not resolve ".../babel-plugin-react-compiler"`**: the plugin is missing from the
  GenesisTools checkout. Run `bun install` there.
- **`Compilation error: <message>`** The input does not parse, or the compiler rejected an option. Fix the syntax
  error the message names. Add `-v` for the stack.
- **`Compilation failed - no output generated`** Babel returned no code. Add `-v` for details.
- **`Memoized: No` for a component you expected to compile.** Check these causes in order:
  - With `--target 17` or `18` the summary is wrong. Look for `_c(` in the output.
  - In `infer` mode the function must have a capitalized name (or a `use` name for a hook) and create JSX or call a
    hook. Try `--mode all`.
  - The file path contains `node_modules`. The compiler skips such files by default. Copy the file elsewhere, or pipe
    it with `--stdin` (the filename is then `stdin.tsx`).
  - The compiler bailed out. Run with `-v` and read the `CompileError` event.
- **Output differs from your build.** The tool ignores your Babel config and uses its own compiler version. Pass your
  project's `--target` and `--mode`, and compare the plugin versions.
