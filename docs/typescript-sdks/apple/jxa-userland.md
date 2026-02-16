# JXA-userland/JXA -- Comprehensive Exploration

> Repository: https://github.com/JXA-userland/JXA
> Author: [azu](https://github.com/azu)
> License: MIT
> Current Version: 1.4.0 (April 2025)
> Last meaningful feature: class inheritance support via `_jxa_inherits` in sdef-to-dts

---

## Table of Contents

1. [Monorepo Overview](#1-monorepo-overview)
2. [Package Relationship Map](#2-package-relationship-map)
3. [Package: @jxa/run](#3-package-jxarun)
4. [Package: @jxa/repl](#4-package-jxarepl)
5. [Package: @jxa/sdef-to-dts](#5-package-jxasdef-to-dts)
6. [Package: @jxa/types](#6-package-jxatypes)
7. [Package: @jxa/global-type](#7-package-jxaglobal-type)
8. [Example Package](#8-example-package)
9. [Deep Dive: sdef-to-dts Internals](#9-deep-dive-sdef-to-dts-internals)
10. [Deep Dive: @jxa/run Internals](#10-deep-dive-jxarun-internals)
11. [Generated Type Examples](#11-generated-type-examples)
12. [How to Generate Types for Any App](#12-how-to-generate-types-for-any-app)
13. [Production Readiness Assessment](#13-production-readiness-assessment)
14. [Integration Plan for GenesisTools](#14-integration-plan-for-genesistools)
15. [What Mail.app Types Look Like](#15-what-mailapp-types-look-like)
16. [Limitations and Gaps](#16-limitations-and-gaps)
17. [Alternative Approaches and Related Projects](#17-alternative-approaches-and-related-projects)

---

## 1. Monorepo Overview

### Build System

- **Package Manager**: Yarn 1 (classic) with workspaces
- **Monorepo Tool**: Lerna v2 (declared) / v3 (installed) with `useWorkspaces: true`
- **Language**: TypeScript 4.7.x, compiled to JavaScript (no Bun, no ESM -- all CommonJS)
- **Test Framework**: Mocha with ts-node
- **CI**: GitHub Actions, runs on `macos-latest` (required because tests invoke `osascript`)

### Workspace Layout

```
/
  lerna.json              # version: "1.4.0", npmClient: yarn, useWorkspaces: true
  package.json            # root: workspaces ["example/", "packages/*", "packages/@jxa/*"]
  yarn.lock
  example/                # Standalone example package
  packages/
    @jxa/
      global-type/        # Declares JXA globals (Application, ObjC, $, etc.)
      repl/               # Interactive JXA REPL via Node.js
      run/                # Execute JXA from Node.js via osascript
      sdef-to-dts/        # Convert .sdef XML to TypeScript .d.ts
      types/              # Pre-generated .d.ts for 25+ macOS apps
```

### Versioning

All packages are kept in lockstep at the same version (currently `1.4.0`). Lerna manages
conventional-commits-based versioning. The `versionup` scripts use `lerna version --conventional-commits`.

### Key Scripts

```bash
yarn bootstrap    # lerna bootstrap + build all packages
yarn test         # lerna run test across all packages
yarn build        # lerna run build (tsc) across all packages
```

---

## 2. Package Relationship Map

```
                    +------------------+
                    | @jxa/sdef-to-dts |
                    |  (SDEF parser)   |
                    +--------+---------+
                             |
                    used by tools/sdef-to-dts.js
                             |
                    +--------v---------+
                    |   @jxa/types     |
                    | (pre-generated   |
                    |  .d.ts files)    |
                    +--------+---------+
                             |
                    imported by
                             |
                    +--------v---------+
                    | @jxa/global-type |
                    | (augments global |
                    |  namespace)      |
                    +--------+---------+
                             |
            +----------------+----------------+
            |                                 |
   +--------v---------+            +----------v--------+
   |   @jxa/run        |            |    @jxa/repl      |
   | (Node.js -> JXA   |            | (interactive REPL |
   |  via osascript)   |<-----------+  uses @jxa/run)   |
   +-------------------+            +-------------------+
```

**Dependency summary:**
- `@jxa/global-type` depends on `@jxa/types`
- `@jxa/repl` depends on `@jxa/run`
- `@jxa/types` uses `@jxa/sdef-to-dts` as a devDependency (for regenerating types)
- `@jxa/run` uses `@jxa/global-type` as a devDependency (for type-checking tests)
- `@jxa/sdef-to-dts` has no internal dependencies (standalone)

---

## 3. Package: @jxa/run

**Purpose**: Execute JXA (JavaScript for Automation) code from Node.js and retrieve results.

**npm**: `@jxa/run@1.4.0`
**Source**: `packages/@jxa/run/src/run.ts` (single file, 127 lines)
**Runtime dependency**: `macos-version` (asserts macOS >= 10.10)

### API

```typescript
// Execute raw JXA code string
function runJXACode(jxaCode: string): Promise<any>;

// Execute a function as JXA with typed arguments (up to 9 args)
function run<R>(jxaCodeFunction: (...args: any[]) => void, ...args: any[]): Promise<R>;
function run<R, A1>(jxaCodeFunction: (a1: A1) => void, a1: A1): Promise<R>;
// ... overloads up to 9 arguments for type safety
```

### How It Works

1. **Serialization**: The user-provided function is serialized via `.toString()`. This means
   closures DO NOT WORK -- the function must be self-contained.

2. **Argument Passing**: Arguments are JSON-serialized and passed via the `OSA_ARGS` environment
   variable. Inside the JXA environment, they are read back via `$.getenv('OSA_ARGS')`.

3. **Execution**: Uses `child_process.execFile` to invoke `/usr/bin/osascript -l JavaScript`.
   The JXA code is written to stdin of the child process.

4. **Result Handling**: The JXA code wraps the function result in `JSON.stringify({ result: out })`.
   Node.js parses this JSON from stdout. If parsing fails, raw stdout is returned as a string.

### Generated JXA Code Template

When you call `run(fn, arg1, arg2)`, this JXA code is generated and piped to osascript:

```javascript
ObjC.import('stdlib');
var args = JSON.parse($.getenv('OSA_ARGS'));
var fn   = (<serialized function body>);
var out  = fn.apply(null, args);
JSON.stringify({ result: out });
```

### Error Handling

- macOS version check via `macosVersion.assertGreaterThanOrEqualTo("10.10")`
- `execFile` errors are rejected as Promise rejections
- stderr is logged to `console.error` but does not cause rejection
- If stdout is empty, resolves with `undefined`
- JSON parse failures fall back to returning raw trimmed stdout

### Buffer Limits

- `DEFAULT_MAX_BUFFER = 1000 * 1000 * 100` (100 MB) -- increased in v1.3.2 from default 200KB
  to handle large JXA results

### Usage Examples

```typescript
import { run, runJXACode } from "@jxa/run";

// Simple: raw JXA code
const result = await runJXACode(`Application("System Events").currentUser().name();`);

// Typed: function serialization with arguments
const greeting = await run<string>((name: string) => {
    return "Hello, " + name + "!";
}, "World");

// System access
const username = await run(() => {
    return Application("System Events").currentUser().name();
});

// CRITICAL LIMITATION: Closures don't work
const name = "World";
// BAD - `name` is undefined in JXA context:
await run(() => "Hello " + name);
// GOOD - pass as argument:
await run((n) => "Hello " + n, name);
```

---

## 4. Package: @jxa/repl

**Purpose**: Interactive REPL for executing JXA commands from the terminal.

**npm**: `@jxa/repl@1.4.0`
**Binary**: `jxa-repl`
**Source**: `packages/@jxa/repl/src/repl.ts` (39 lines) + `cli.ts` (6 lines)
**Dependency**: `@jxa/run`

### How It Works

1. Uses Node.js built-in `repl` module with a custom `eval` function
2. Each entered command is accumulated in a `cmdStack` array
3. On each evaluation, ALL accumulated commands are concatenated and sent to `runJXACode`
4. The `.clear` command resets the stack (releases all defined variables)
5. Output is formatted via `util.inspect`

### Architecture

```
User Input  -->  cmdStack (append)  -->  join("\n")  -->  runJXACode()  -->  display result
                    ^                                           |
                    |___________________________________________|
                          (previous commands preserved)
```

### Key Source: repl.ts

```typescript
export class JXARepl {
    private replServer!: repl.REPLServer;

    start() {
        this.replServer = repl.start({ prompt: '> ', eval: myEval, writer: myWriter });
        const cmdStack: string[] = [];

        this.replServer.defineCommand("clear", () => {
            cmdStack.length = 0;
            (this.replServer as any).clearBufferedCommand();
        });

        function myEval(cmd, _context, _filename, callback) {
            if (cmd.length === 0) return callback(null);
            const code = cmdStack.join("\n") + "\n" + cmd;
            runJXACode(code).then(output => {
                cmdStack.push(cmd);
                callback(null, util.inspect(output));
            }).catch(error => callback(error));
        }
    }
}
```

### Usage

```bash
$ npx @jxa/repl
> Application("Finder").version()
'14.3'
> var mail = Application("Mail")
undefined
> mail.inbox()
# ... mail inbox data
> .clear
# resets all state
```

### Limitations

- Every command re-executes the ENTIRE accumulated history (not incremental)
- No tab completion for JXA methods
- No TypeScript support in the REPL itself
- Performance degrades as command history grows

---

## 5. Package: @jxa/sdef-to-dts

**Purpose**: Convert Apple Scripting Definition (.sdef) XML files into TypeScript declaration
files (.d.ts). This is the core type generation engine.

**npm**: `@jxa/sdef-to-dts@1.4.0`
**Source**: `packages/@jxa/sdef-to-dts/src/sdef-to-dts.ts` (single file, 321 lines)
**Binary**: `sdef-to-dts` (via `bin/cmd.js`)

### Dependencies

| Package | Purpose |
|---------|---------|
| `@rgrove/parse-xml` | XML parser for .sdef files |
| `camelcase` | Convert sdef names to camelCase/PascalCase |
| `is-var-name` | Validate namespace names are valid JS identifiers |
| `indent-string` | Format output indentation |
| `json-schema-to-typescript` | Convert intermediate JSON Schema to TS interfaces |
| `meow` | CLI argument parsing (in bin/cmd.js) |
| `execa` | Shell execution for `sdef` command (in bin/cmd.js) |

### API

```typescript
// Core transform function
export async function transform(namespace: string, sdefContent: string): Promise<string>;
```

**Parameters:**
- `namespace`: A valid JavaScript identifier used as the TypeScript namespace (e.g., "Mail", "Finder")
- `sdefContent`: Raw XML content of the .sdef file

**Returns:** Complete TypeScript declaration file content as a string

### CLI Usage

```bash
# Convert an app bundle directly (uses macOS `sdef` command to extract .sdef)
npx @jxa/sdef-to-dts /Applications/Safari.app --output ./safari.d.ts

# The CLI:
# 1. Calls `sdef /Applications/Safari.app` to get the XML
# 2. Calls transform(appName, sdefXml)
# 3. Writes result to output file
```

### Programmatic Usage

```typescript
const fs = require("fs");
const { transform } = require("@jxa/sdef-to-dts");

const sdefContent = fs.readFileSync("./Mail.sdef", "utf-8");
const dtsContent = await transform("Mail", sdefContent);
fs.writeFileSync("./Mail.d.ts", dtsContent, "utf-8");
```

---

## 6. Package: @jxa/types

**Purpose**: Pre-generated TypeScript type definitions for 25+ built-in macOS applications.

**npm**: `@jxa/types@1.4.0`
**Source**: Pure `.d.ts` files in `src/` -- no runtime code
**Main entry**: `src/index.d.ts`

### Included Application Types

All generated from `.sdef` files stored in `tools/sdefs/`:

| Application | Type Name | File |
|-------------|-----------|------|
| Calendar | `Calendar` | `src/core/Calendar.d.ts` |
| Contacts | `Contacts` | `src/core/Contacts.d.ts` |
| Database Events | `DatabaseEvents` | `src/core/DatabaseEvents.d.ts` |
| DVD Player | `DVDPlayer` | `src/core/DvdPlayer.d.ts` |
| Finder | `Finder` | `src/core/Finder.d.ts` |
| Font Book | `FontBook` | `src/core/FontBook.d.ts` |
| Image Events | `ImageEvents` | `src/core/ImageEvents.d.ts` |
| iTunes | `iTunes` | `src/core/ITunes.d.ts` |
| Keynote | `Keynote` | `src/core/Keynote.d.ts` |
| Mail | `Mail` | `src/core/Mail.d.ts` |
| Messages | `Messages` | `src/core/Messages.d.ts` |
| Notes | `Notes` | `src/core/Notes.d.ts` |
| Numbers | `Numbers` | `src/core/Numbers.d.ts` |
| Pages | `Pages` | `src/core/Pages.d.ts` |
| Photos | `Photos` | `src/core/Photos.d.ts` |
| QuickTime Player | `QuickTimePlayer` | `src/core/QuickTimePlayer.d.ts` |
| Reminders | `Reminders` | `src/core/Reminders.d.ts` |
| Safari | `Safari` | `src/core/Safari.d.ts` |
| Script Editor | `ScriptEditor` | `src/core/ScriptEditor.d.ts` |
| Speech Recognition | `SpeechRecognitionServer` | `src/core/SpeechRecognitionServer.d.ts` |
| Standard Additions | `StandardAdditions` | `src/core/StandardAdditions.d.ts` |
| System Events | `SystemEvents` | `src/core/SystemEvents.d.ts` |
| Terminal | `Terminal` | `src/core/Terminal.d.ts` |
| TextEdit | `TextEdit` | `src/core/TextEdit.d.ts` |
| VoiceOver | `VoiceOver` | `src/core/VoiceOver.d.ts` |

### Core Type Files

**`src/Application.d.ts`** -- The main `Application` function and namespace:

```typescript
// Function overloads for known applications
declare function Application(name: "Mail"): App & Application._Mail;
declare function Application(name: "Finder"): App & Application._Finder;
declare function Application(name: "Safari"): App & Application._Safari;
// ... 25+ overloads

// Generic overload for custom types
declare function Application<T>(name: string):
    typeof Application & Application._StandardAdditions & Application.AnyValue & T;

// Namespace with utility methods
declare namespace Application {
    function currentApplication<T = any>(): typeof Application &
        Application._StandardAdditions & Application.AnyValue;
    var includeStandardAdditions: boolean;
    function id(): number;
    function name(): string;
    function running(): boolean;
    function activate(): void;
    function quit(): void;
    function launch(): void;
    function commandsOfClass(): string[];
    function elementsOfClass(className: string): string[];
    function propertiesOfClass(className: string): string[];
    function parentOfClass(className: string): string;
    var windows: any;
}
```

**`src/Automation.d.ts`** -- The `Automation` class:

```typescript
declare namespace Automation {
    function getDisplayString(arg: any): string;
    function log(arg: any): void;
}
```

**`src/ObjectSpecifier.d.ts`** -- The `ObjectSpecifier` class:

```typescript
declare namespace ObjectSpecifier {
    function hasInstance(arg: any): boolean;
    function classOf(arg: any): string;
    function callAsFunction(): typeof ObjectSpecifier;
}
```

### Regenerating Types

The `.sdef` files are stored in `tools/sdefs/`. To regenerate:

```bash
cd packages/@jxa/types
yarn run dts:update   # runs tools/sdef-to-dts.js
```

The script reads all `.sdef` files, passes them through `@jxa/sdef-to-dts`'s `transform()`,
and writes output to `src/core/`.

```javascript
// tools/sdef-to-dts.js
const { transform } = require("@jxa/sdef-to-dts");
const fixturesDir = path.join(__dirname, "sdefs");
const outputDir = path.join(__dirname, "../src/core");

fs.readdirSync(fixturesDir).map(async caseName => {
    const fileName = path.basename(caseName, ".sdef");
    const normalizedTestName = fileName.replace(/\s/g, "");
    const actualContent = fs.readFileSync(path.join(fixturesDir, caseName), "utf-8");
    const actual = await transform(normalizedTestName, actualContent);
    fs.writeFileSync(path.join(outputDir, normalizedTestName) + ".d.ts", actual, "utf-8");
});
```

### Custom Application Types (Generics)

For apps not included in the pre-generated set, use the generic overload:

```typescript
import { Application } from "@jxa/types";
import { GoogleChrome } from "./GoogleChrome.d.ts"; // your generated types

const chrome = Application<GoogleChrome>("Google Chrome");
// chrome: typeof Application & _StandardAdditions & AnyValue & GoogleChrome
const tab = chrome.windows[0].activeTab();
```

---

## 7. Package: @jxa/global-type

**Purpose**: Augments the global TypeScript scope with JXA built-ins (`Application`, `Automation`,
`ObjectSpecifier`, `ObjC`, `$`, `Path`, `delay`).

**npm**: `@jxa/global-type@1.4.0`
**Dependency**: `@jxa/types`
**Source**: `src/index.d.ts` (23 lines) + `src/index.js` (empty, 3-line comment file)

### What It Declares

```typescript
import type { Application, ObjectSpecifier, Automation } from "@jxa/types";

declare global {
    const Application: typeof Application;
    const Automation: typeof Automation;
    const ObjectSpecifier: typeof ObjectSpecifier;

    function Path(name: string): object;
    function delay(delay?: number): void;

    const ObjC: any;    // Objective-C bridge (untyped)
    const $: any;        // Shorthand for ObjC (untyped)
}
```

### Usage

Simply importing this package augments the global scope:

```typescript
// Method 1: Import side-effect
import "@jxa/global-type";

// Method 2: Triple-slash reference
/// <reference path="./node_modules/@jxa/global-type/src/index.d.ts" />

// Now these are globally available:
const app = Application("Finder");
const user = Application("System Events").currentUser().name();
delay(1);
```

### Test Fixtures

The package includes ~100 test fixtures from openspc2.org JXA examples, covering:

- Standard operations (dialogs, sounds, keys, screens, users)
- Finder operations
- TextEdit operations
- Safari operations
- Mail operations
- Adobe apps (Acrobat, AfterEffects, Illustrator, InDesign, Photoshop)
- UNIX operations (shell, bash, Ruby, commands)
- Objective-C/Cocoa bridge

Example test fixture (`Finder-application-0001/sample.ts`):

```typescript
var Finder = Application("Finder");
var version = Finder.version();
Finder.includeStandardAdditions = true;
Finder.displayAlert(version);
```

---

## 8. Example Package

**Location**: `example/`
**Dependencies**: `@jxa/global-type`, `@jxa/run`

Demonstrates the canonical usage pattern: write JXA code in TypeScript with full type checking,
then execute it from Node.js.

```typescript
// example/src/example.ts
import "@jxa/global-type";
import { run } from "@jxa/run";

export const safariVersion = () => {
    return run(() => {
        const Safari = Application("Safari");
        return Safari.version();
    });
};

export const currentUserName = () => {
    return run(() => {
        const sys = Application("System Events");
        return sys.currentUser().name();
    });
};

export const example = async () => {
    const version = await safariVersion();
    const userName = await currentUserName();
    return `User: ${userName}, Safari: ${version}`;
};
```

---

## 9. Deep Dive: sdef-to-dts Internals

### SDEF XML Structure

Apple's Scripting Definition format is XML with this hierarchy:

```xml
<dictionary>
  <suite name="..." code="..." description="...">
    <command name="..." code="..." description="...">
      <direct-parameter type="..." optional="yes|no" description="..."/>
      <parameter name="..." code="..." type="..." optional="yes|no" description="..."/>
      <result type="..." description="..."/>
    </command>
    <record-type name="..." code="..." description="...">
      <property name="..." code="..." type="..." description="..." optional="yes|no"/>
    </record-type>
    <class name="..." code="..." description="..." inherits="...">
      <property name="..." code="..." type="..." description="..." optional="yes|no"/>
    </class>
    <class-extension extends="..." code="..." description="...">
      <property name="..." code="..." type="..." description="..." optional="yes|no"/>
    </class-extension>
    <!-- enums are NOT supported (TODO in source) -->
  </suite>
</dictionary>
```

### Parser Pipeline

The `transform()` function processes sdef XML through these stages:

```
SDEF XML
  |
  v
[1] parseXml() -- @rgrove/parse-xml
  |   Produces a DOM-like tree of nodes
  v
[2] Extract Suites
  |   Filter dictionary.children for name === "suite"
  v
[3] Categorize Suite Children
  |   For each suite, classify nodes into:
  |     - commands (name === "command")
  |     - records (name === "record-type")
  |     - classes (name === "class")
  |     - classExtensions (name === "class-extension")
  v
[4] Convert to JSON Schema
  |   records, classes, classExtensions --> JSONSchema objects via recordToJSONSchema()
  v
[5] Generate TypeScript Interfaces
  |   JSON Schemas --> TS interfaces via json-schema-to-typescript's compile()
  |   Post-processing: replace properties with methods (name: -> name():)
  |   Add inheritance (extends) based on _jxa_inherits
  v
[6] Generate Function Declarations
  |   commands --> function signatures via commandToDeclare()
  |   Each command produces:
  |     - Optional parameter interface (if command has named parameters)
  |     - Function signature with JSDoc
  v
[7] Assemble Output
  |   Wrap everything in namespace + interface structure
  v
TypeScript .d.ts
```

### Type Conversion

SDEF types are mapped to TypeScript types:

```typescript
// For JSON Schema (used in interface property types):
const convertJSONSchemaType = (type: string): string => {
    switch (type) {
        case "text":     return "string";
        case "number":
        case "integer":  return "integer";   // JSON Schema integer
        case "boolean":  return "boolean";
        case "Any":
        case "type class": return "any";
    }
    return "any";  // fallback -- custom types become "any" in JSON Schema
};

// For function signatures (supports cross-references):
const convertType = (type, namespace, definedJSONSchemaList) => {
    switch (type) {
        case "text":     return "string";
        case "number":
        case "integer":  return "number";
        case "boolean":  return "boolean";
        case "Any":
        case "type class": return "any";
    }
    // Check if type was defined as a record/class
    const otherType = pascalCase(type);
    const isDefined = definedJSONSchemaList.some(s => s.title === otherType);
    return isDefined ? `${namespace}.${otherType}` : "any";
};
```

### Name Conversion Strategy

SDEF uses space-separated names (e.g., "choose file", "big message warning size").
These are converted:

- **Functions**: camelCase -- "choose file" -> `chooseFile`
- **Interfaces/Types**: PascalCase -- "rich text" -> `RichText`
- **Special handling**: Consecutive uppercase letters are preserved
  (e.g., "URL" stays "URL", not "Url")

```typescript
const camelCase = (text: string) => {
    const camelCased = camelCaseLib(text);
    const UPPER_CASE = /([A-Z]{2,})/;
    const match = text.match(UPPER_CASE);
    if (match && match[1]) {
        return camelCased.replace(new RegExp(match[1], "i"), match[1]);
    }
    return camelCased;
};
```

### Inheritance Support (v1.4.0)

Added in April 2025 via a "very hacky way" (per the commit message). When a `<class>` has
an `inherits` attribute, the generated interface includes `extends`:

```typescript
const recordToJSONSchema = (command: Record | Class | ClassExtension): JSONSchema => {
    // ...
    const inherits = command.attributes.inherits == null
        ? undefined
        : pascalCase(command.attributes.inherits);
    return {
        title: pascalCaseName,
        _jxa_inherits: inherits,  // custom non-standard field
        // ... standard JSON Schema fields
    };
};
```

During interface generation, `_jxa_inherits` is used to add extends:

```typescript
let interfaceHeader = `interface ${title}`;
if (schema._jxa_inherits != null) {
    interfaceHeader += ` extends ${schema._jxa_inherits}`;
}
```

### Command Processing

Each SDEF `<command>` becomes:
1. An optional parameter interface (if the command has named parameters)
2. A method on the main namespace interface

```typescript
// SDEF:
// <command name="forward" description="Creates a forwarded message.">
//   <direct-parameter type="message" description="the message to forward"/>
//   <parameter name="opening window" type="boolean" optional="yes"/>
//   <result type="outgoing message"/>
// </command>

// Generated TypeScript:
export interface ForwardOptionalParameter {
    openingWindow?: boolean;
}

// On the Mail interface:
forward(directParameter: Mail.Message, option?: Mail.ForwardOptionalParameter): Mail.OutgoingMessage;
```

### Output Structure

The generated `.d.ts` follows this template:

```typescript
export namespace AppName {
    // Default Application
    export interface Application {}

    // Class -- interfaces from <class> elements
    export interface ClassName { /* properties as methods */ }

    // Class Extension -- interfaces from <class-extension> elements
    export interface Application { /* extended properties */ }

    // Records -- interfaces from <record-type> elements
    export interface RecordName { /* properties as methods */ }

    // Function options -- parameter interfaces for commands
    export interface CommandNameOptionalParameter { /* optional params */ }
}

export interface AppName extends AppName.Application {
    // Functions -- methods from <command> elements
    commandName(directParam: type, option?: AppName.CommandOptionalParameter): ReturnType;
}
```

### Property-to-Method Conversion

A critical post-processing step converts all properties to methods:

```typescript
// json-schema-to-typescript generates: name: string;
// Post-processing regex converts to: name(): string;
definition.replace(/(\w+):(.*;)/g, "$1():$2");
```

This is because JXA properties are accessed as method calls, not property access:
`app.name()` not `app.name`.

### Duplicate Name Handling

If multiple commands have the same PascalCase name for their optional parameters,
a counter suffix is added:

```typescript
let optionalParameterTypeName = `${pascalCaseName}OptionalParameter`;
const count = optionalMap.get(optionalParameterTypeName) || 0;
if (count > 0) {
    optionalParameterTypeName += String(count);
}
// Results in: PathToOptionalParameter, PathToOptionalParameter1
```

---

## 10. Deep Dive: @jxa/run Internals

### Execution Flow

```
Node.js                                  macOS
  |                                        |
  | 1. Serialize function via .toString()  |
  | 2. JSON.stringify args                 |
  | 3. Set OSA_ARGS env var                |
  | 4. execFile("/usr/bin/osascript",      |
  |    ["-l", "JavaScript"])               |
  |-------- stdin: JXA code --------------->|
  |                                        | 5. JXA engine parses code
  |                                        | 6. ObjC.import('stdlib')
  |                                        | 7. Read args from env
  |                                        | 8. Execute function
  |                                        | 9. JSON.stringify result
  |<------- stdout: JSON result ------------|
  | 10. Parse JSON                         |
  | 11. Resolve promise with .result       |
  |                                        |
```

### Serialization Details

The `run()` function uses a clever approach:

```typescript
export function run(jxaCodeFunction, ...args) {
    const code = `
ObjC.import('stdlib');
var args = JSON.parse($.getenv('OSA_ARGS'));
var fn   = (${jxaCodeFunction.toString()});
var out  = fn.apply(null, args);
JSON.stringify({ result: out });
`;
    return executeInOsa(code, args);
}
```

Key aspects:
- `ObjC.import('stdlib')` is needed to access `$.getenv()`
- Arguments are passed via environment variable (not stdin) to avoid conflicts
- The function is embedded directly in the code via `.toString()`
- Result wrapping in `{ result: out }` handles undefined/null properly
- The entire code block is written to stdin of the osascript process

### osascript Invocation

```typescript
const child = execFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript"],       // language: JavaScript (JXA mode)
    {
        env: {
            OSA_ARGS: JSON.stringify(args)  // only this env var is set
        },
        maxBuffer: DEFAULT_MAX_BUFFER       // 100MB
    },
    (err, stdout, stderr) => { /* ... */ }
);
child.stdin.write(code);
child.stdin.end();
```

Note: The env is set to ONLY `OSA_ARGS` -- the rest of the parent environment is NOT inherited.
This is because they use `env:` instead of merging with `process.env`.

### runJXACode vs run

- `runJXACode(code)`: Passes raw code directly to osascript. No argument injection, no result
  wrapping. The JXA code's last expression becomes stdout.
- `run(fn, ...args)`: Wraps the function with argument deserialization and result serialization.

### Type Safety

The `run` function has overloads for up to 9 typed arguments:

```typescript
function run<R, A1, A2>(fn: (a1: A1, a2: A2) => void, a1: A1, a2: A2): Promise<R>;
```

The return type `R` must be explicitly specified by the caller (it defaults to `void`
in the function signature but the actual implementation resolves whatever is returned).

### Gotchas

1. **No closure support**: The function is serialized, so it cannot reference outer scope
2. **No complex objects**: Arguments must be JSON-serializable (no functions, Dates, etc.)
3. **Env inheritance**: Parent process env vars are NOT available in the JXA context
4. **Sync execution**: Each `run()` spawns a new osascript process -- expensive for frequent calls
5. **Error messages**: osascript errors come through the callback `err` parameter, but
   often lack useful stack traces
6. **Return type**: The result goes through JSON round-trip, so Dates become strings,
   functions are lost, etc.

---

## 11. Generated Type Examples

### Mail.app (Mail.d.ts) -- Key Interfaces

The Mail type file is 1,357 lines and includes:

**Classes:**
- `RichText`, `Attachment`, `Paragraph`, `Word`, `Character`, `AttributeRun` -- text formatting
- `OutgoingMessage` -- composing new messages (sender, subject, visible, messageSignature, id)
- `MessageViewer` -- mail viewer window state
- `Signature` -- email signatures
- `Message` -- full email message with 20+ properties:
  - `id()`, `allHeaders()`, `mailbox()`, `content()`, `dateReceived()`, `dateSent()`
  - `deletedStatus()`, `flaggedStatus()`, `junkMailStatus()`, `readStatus()`
  - `messageId()`, `source()`, `replyTo()`, `messageSize()`, `sender()`, `subject()`
  - `wasForwarded()`, `wasRedirected()`, `wasRepliedTo()`
- `Account`, `ImapAccount`, `ICloudAccount`, `PopAccount`, `SmtpServer` -- account types
- `Mailbox` -- mailbox with name, unreadCount, account
- `Rule`, `RuleCondition` -- mail rules
- `Recipient`, `BccRecipient`, `CcRecipient`, `ToRecipient` -- recipients
- `Container`, `Header`, `MailAttachment`

**Class Extension (Application properties):**
- 60+ properties for Mail app configuration (alwaysBccMyself, fetchInterval,
  defaultMessageFormat, inbox, outbox, draftsMailbox, etc.)

**Commands (as methods on the Mail interface):**
- `delete`, `duplicate`, `move`, `bounce`, `checkForNewMail`, `extractNameFrom`,
  `extractAddressFrom`, `forward`, `getURL`, `importMailMailbox`, `mailto`,
  `performMailActionWithMessages`, `redirect`, `reply`, `send`, `synchronize`

### Notes.app (Notes.d.ts) -- Minimal Example

```typescript
export namespace Notes {
    export interface Application {}

    export interface Account {
        name(): string;
        id(): string;
    }

    export interface Folder {
        name(): string;
        id(): string;
        container(): any;
    }

    export interface Note {
        name(): string;
        id(): string;
        container(): any;
        body(): string;         // HTML content
        creationDate(): any;
        modificationDate(): any;
    }

    export interface Attachment {
        name(): string;
        id(): string;
        container(): any;
        contentIdentifier(): string;
    }
}

export interface Notes extends Notes.Application {
    openNoteLocation(directParameter: {}, ): void;
}
```

### Safari.app (Safari.d.ts) -- Browser Automation Types

```typescript
export namespace Safari {
    export interface Tab {
        source(): string;    // HTML source
        URL(): string;       // current URL
        index(): number;
        text(): string;      // page text content
        visible(): boolean;
        name(): string;      // tab title
    }

    export interface Window {
        currentTab(): any;
    }

    export interface Document {
        source(): string;
        URL(): string;
        text(): string;
    }
}

export interface Safari extends Safari.Application {
    addReadingListItem(url: string, option?: Safari.AddReadingListItemOptionalParameter): void;
    doJavaScript(code: string, option?: Safari.DoJavaScriptOptionalParameter): any;
    emailContents(option?: Safari.EmailContentsOptionalParameter): void;
    searchTheWeb(option?: Safari.SearchTheWebOptionalParameter): void;
    showBookmarks(): void;
}
```

### Google Chrome (Test Fixture) -- Custom App Types

The repo includes a `GoogleChrome.d.ts` test fixture showing third-party app types:

```typescript
export namespace GoogleChrome {
    export interface Window {
        name(): string;
        id(): number;
        activeTab(): any;
        mode(): string;        // 'normal' or 'incognito'
        activeTabIndex(): number;
    }

    export interface Tab {
        id(): number;
        title(): string;
        URL(): string;
        loading(): boolean;
    }

    export interface BookmarkFolder { /* ... */ }
    export interface BookmarkItem { /* ... */ }
}

export interface GoogleChrome extends GoogleChrome.Application {
    reload(tab: any): void;
    goBack(tab: any): void;
    execute(tab: any, option?: { javascript: string }): any;
    // ... standard CRUD operations
}
```

---

## 12. How to Generate Types for Any App

### Method 1: CLI (easiest)

```bash
# Install
npm install -g @jxa/sdef-to-dts

# Generate for any .app bundle
sdef-to-dts /Applications/Mail.app --output ./Mail.d.ts
sdef-to-dts /Applications/Notes.app --output ./Notes.d.ts
sdef-to-dts "/Applications/Google Chrome.app" --output ./GoogleChrome.d.ts
sdef-to-dts /Applications/Slack.app --output ./Slack.d.ts
sdef-to-dts /Applications/Spotify.app --output ./Spotify.d.ts
```

### Method 2: Extract SDEF Manually, Then Transform

```bash
# Step 1: Get the .sdef XML from any scriptable app
sdef /Applications/Mail.app > Mail.sdef

# Step 2: Use the library
```

```typescript
const fs = require("fs");
const { transform } = require("@jxa/sdef-to-dts");

const sdef = fs.readFileSync("./Mail.sdef", "utf-8");
const dts = await transform("Mail", sdef);
fs.writeFileSync("./Mail.d.ts", dts, "utf-8");
```

### Method 3: Batch Generate for All Scriptable Apps

```bash
# Find all scriptable apps on the system
for app in /Applications/*.app; do
    name=$(basename "$app" .app | tr -d ' ')
    sdef "$app" > "/tmp/${name}.sdef" 2>/dev/null && \
    echo "Found: $name"
done
```

```typescript
// Then batch-transform
const fs = require("fs");
const path = require("path");
const { transform } = require("@jxa/sdef-to-dts");

const sdefDir = "/tmp/sdefs";
const outDir = "./generated-types";

for (const file of fs.readdirSync(sdefDir)) {
    if (!file.endsWith('.sdef')) continue;
    const name = path.basename(file, '.sdef');
    const content = fs.readFileSync(path.join(sdefDir, file), 'utf-8');
    const dts = await transform(name, content);
    fs.writeFileSync(path.join(outDir, `${name}.d.ts`), dts, 'utf-8');
}
```

### Using Generated Types

```typescript
import "@jxa/global-type";
import { run } from "@jxa/run";

// For pre-included apps -- types work automatically:
const version = await run(() => Application("Mail").version());

// For custom apps -- use generics:
import { MyApp } from "./MyApp.d.ts";
const result = await run(() => {
    const app = Application<MyApp>("My App");
    return app.someMethod();
});
```

---

## 13. Production Readiness Assessment

### What Works Well

| Component | Status | Notes |
|-----------|--------|-------|
| `@jxa/run` core execution | **Solid** | Simple, battle-tested approach. 100MB buffer. |
| `@jxa/sdef-to-dts` parser | **Functional** | Handles commands, classes, records, class-extensions, inheritance. |
| `@jxa/types` pre-generated | **Good** | 25+ apps covered. Types match actual sdef definitions. |
| `@jxa/global-type` | **Good** | Clean global augmentation approach. |
| CLI tooling | **Basic but working** | sdef-to-dts CLI works for single apps. |

### What Needs Work

| Issue | Severity | Details |
|-------|----------|---------|
| **Enum support missing** | High | SDEF `<enumeration>` elements are completely ignored. Many properties typed as `any` should be string literal unions. |
| **Element access untyped** | High | `app.mailboxes`, `app.windows` are `any`. No typing for element collections or `whose()` filtering. |
| **Date types** | Medium | All date properties return `any` instead of `Date`. |
| **List types** | Medium | Properties that return arrays are typed as `any` instead of `Type[]`. |
| **ObjC bridge untyped** | Medium | `ObjC` and `$` are `any`. No types for Objective-C bridge. |
| **No setter types** | Medium | Properties are only typed as getters (methods). No `property.set()` or assignment typing. |
| **Outdated dependencies** | Low | Uses json-schema-to-typescript v5 (current is v15+), parse-xml v1 (v4 available). |
| **No ESM** | Low | All CommonJS. Modern projects may want ESM. |
| **REPL** re-executes everything | Low | Performance degrades with history length. |
| **Process spawning overhead** | Medium | Each `run()` spawns osascript. No connection pooling. |
| **No streaming** | Medium | Results must fit in memory (100MB max). |
| **env isolation** | Medium | `executeInOsa` sets env to ONLY `OSA_ARGS`, not merging with process.env. |

### Specific Type Quality Issues

1. **Many `any` types**: The type converter falls back to `any` for any type it does not
   recognize. This includes all Apple-specific types like `RGB color`, `alias`, `file`,
   `type class`, etc.

2. **Class hierarchy lost**: While v1.4.0 added `extends` support, the element collections
   (e.g., Finder.Item having `containers`, `files`, `folders`) are not represented.

3. **No readonly**: Properties that are read-only in the sdef are not marked as `readonly`.

4. **record-type properties**: Record types have their properties converted to methods,
   but records in JXA are actually plain objects (properties, not methods).

---

## 14. Integration Plan for GenesisTools

### Vision

Build a `tools jxa` command for typed macOS automation from GenesisTools:

```bash
# Generate types for any app
tools jxa generate-types /Applications/Mail.app -o src/jxa/types/

# Run typed JXA scripts
tools jxa run scripts/get-unread-mail.ts

# Interactive REPL with types
tools jxa repl

# List all scriptable apps
tools jxa list-apps
```

### Architecture Proposal

```
src/jxa/
  index.ts              # Main entry point, commander setup
  commands/
    generate-types.ts   # Wraps sdef-to-dts with improvements
    run.ts              # Execute JXA scripts
    repl.ts             # Enhanced REPL
    list-apps.ts        # Discover scriptable apps
  lib/
    executor.ts         # Improved @jxa/run (Bun.spawn, error handling)
    sdef-parser.ts      # Enhanced sdef-to-dts (enum support, better types)
    type-registry.ts    # Manages generated types
  types/
    core/               # Pre-generated types (copied/improved from @jxa/types)
    generated/          # User-generated types
    global.d.ts         # Enhanced global augmentation
```

### Key Improvements Over Upstream

1. **Use Bun.spawn instead of child_process.execFile**:
   ```typescript
   async function runJXA(code: string): Promise<unknown> {
       const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript"], {
           stdin: "pipe",
           env: { ...process.env, OSA_ARGS: JSON.stringify(args) },
       });
       proc.stdin.write(code);
       proc.stdin.end();
       const stdout = await new Response(proc.stdout).text();
       const exitCode = await proc.exited;
       if (exitCode !== 0) throw new Error(`osascript failed: ${exitCode}`);
       return JSON.parse(stdout.trim()).result;
   }
   ```

2. **Add enum support to sdef-to-dts**:
   ```typescript
   // Parse <enumeration> elements from sdef
   // Generate TypeScript string literal unions or const enums
   type MailFormat = "plain text" | "rich text";
   ```

3. **Better type mapping**: Map Apple types to proper TypeScript:
   ```typescript
   // "RGB color" -> [number, number, number]
   // "alias" -> string (path)
   // "date" -> Date
   // "file" -> string (path)
   // "rectangle" -> { x: number, y: number, width: number, height: number }
   ```

4. **Element collection typing**: Generate array-like accessors:
   ```typescript
   interface Mail extends Mail.Application {
       mailboxes: Mail.Mailbox[] & {
           byName(name: string): Mail.Mailbox;
           whose(filter: Partial<Mail.Mailbox>): Mail.Mailbox[];
       };
   }
   ```

5. **Connection pooling**: Keep an osascript process alive for repeated calls:
   ```typescript
   class JXASession {
       private proc: Subprocess;
       async execute(code: string): Promise<unknown> { /* reuse proc */ }
       close() { /* terminate proc */ }
   }
   ```

### Implementation Priority

1. **Phase 1**: Port `@jxa/run` to Bun with improved error handling
2. **Phase 2**: Integrate sdef-to-dts as a library, add `generate-types` command
3. **Phase 3**: Enhance type generation (enums, collections, proper type mapping)
4. **Phase 4**: Build REPL with type-ahead completion
5. **Phase 5**: Create pre-built type bundles for common apps

---

## 15. What Mail.app Types Look Like

The generated `Mail.d.ts` is 1,357 lines. Here is the complete interface structure
(abridged to show the shape):

```typescript
export namespace Mail {
    // --- Classes ---

    export interface RichText {
        color(): any;
        font(): string;
        size(): number;
    }

    export interface Attachment {
        fileName(): any;
    }

    export interface OutgoingMessage {
        sender(): string;
        subject(): string;
        visible(): boolean;
        messageSignature(): any;
        id(): number;
        htmlContent(): string;       // deprecated
    }

    export interface MessageViewer {
        draftsMailbox(): any;
        inbox(): any;
        junkMailbox(): any;
        outbox(): any;
        sentMailbox(): any;
        trashMailbox(): any;
        sortColumn(): any;
        sortedAscending(): boolean;
        mailboxListVisible(): boolean;
        previewPaneIsVisible(): boolean;
        visibleColumns(): any;
        id(): number;
        visibleMessages(): any;
        selectedMessages(): any;
        selectedMailboxes(): any;
    }

    export interface Signature {
        content(): string;
        name(): string;
    }

    export interface Message {
        id(): number;
        allHeaders(): string;
        backgroundColor(): any;
        mailbox(): any;
        content(): any;
        dateReceived(): any;          // should be Date
        dateSent(): any;              // should be Date
        deletedStatus(): boolean;
        flaggedStatus(): boolean;
        flagIndex(): number;
        junkMailStatus(): boolean;
        readStatus(): boolean;
        messageId(): string;
        source(): string;
        replyTo(): string;
        messageSize(): number;
        sender(): string;
        subject(): string;
        wasForwarded(): boolean;
        wasRedirected(): boolean;
        wasRepliedTo(): boolean;
    }

    export interface Account {
        deliveryAccount(): any;
        name(): string;
        id(): string;
        password(): string;           // write-only in practice
        authentication(): any;        // should be enum
        accountType(): any;           // should be enum
        emailAddresses(): any;        // should be string[]
        fullName(): string;
        enabled(): boolean;
        userName(): string;
        port(): number;
        serverName(): string;
        usesSsl(): boolean;
        // ... 10+ more properties
    }

    export interface Mailbox {
        name(): string;
        unreadCount(): number;
        account(): any;
        container(): any;
    }

    export interface Recipient {
        address(): string;
        name(): string;
    }

    export interface MailAttachment {
        name(): string;
        MIMEType(): string;
        fileSize(): number;
        downloaded(): boolean;
        id(): string;
    }

    // --- Class Extension (app-level properties) ---

    export interface Application {
        alwaysBccMyself(): boolean;
        alwaysCcMyself(): boolean;
        selection(): any;
        fetchInterval(): number;
        inbox(): any;
        outbox(): any;
        draftsMailbox(): any;
        sentMailbox(): any;
        trashMailbox(): any;
        junkMailbox(): any;
        primaryEmail(): string;
        // ... 40+ more app-level properties
    }

    // --- Function Option Interfaces ---

    export interface ForwardOptionalParameter {
        openingWindow?: boolean;
    }

    export interface ReplyOptionalParameter {
        openingWindow?: boolean;
        replyToAll?: boolean;
    }

    export interface MoveOptionalParameter {
        to: any;
    }
}

// --- Main Interface (commands as methods) ---

export interface Mail extends Mail.Application {
    delete(directParameter: any): void;
    duplicate(directParameter: any, option?: Mail.DuplicateOptionalParameter): void;
    move(directParameter: any, option?: Mail.MoveOptionalParameter): void;
    bounce(directParameter: Mail.Message): void;
    checkForNewMail(option?: Mail.CheckForNewMailOptionalParameter): void;
    extractNameFrom(directParameter: string): string;
    extractAddressFrom(directParameter: string): string;
    forward(directParameter: Mail.Message, option?: Mail.ForwardOptionalParameter): Mail.OutgoingMessage;
    reply(directParameter: Mail.Message, option?: Mail.ReplyOptionalParameter): Mail.OutgoingMessage;
    send(directParameter: Mail.OutgoingMessage): boolean;
    synchronize(option?: Mail.SynchronizeOptionalParameter): void;
}
```

### What an Improved Version Could Look Like

With enum support, proper date types, and collection typing:

```typescript
export namespace Mail {
    // Enums (currently missing)
    type MessageFormat = "plain text" | "rich text";
    type AccountType = "pop" | "smtp" | "imap" | "iCloud";
    type SortColumn = "date received" | "sender" | "subject" | "flagged" | "mailbox";
    type Authentication = "password" | "apop" | "kerberos v5" | "ntlm" | "md5" | "external" | "Apple token" | "none";

    export interface Message {
        id(): number;
        dateReceived(): Date;
        dateSent(): Date;
        sender(): string;
        subject(): string;
        content(): string;
        readStatus(): boolean;
        flaggedStatus(): boolean;
        mailbox(): Mailbox;
        headers: Header[];
        recipients: Recipient[];
        toRecipients: ToRecipient[];
        ccRecipients: CcRecipient[];
        bccRecipients: BccRecipient[];
        mailAttachments: MailAttachment[];
    }

    export interface Account {
        emailAddresses(): string[];
        accountType(): AccountType;
        authentication(): Authentication;
        // ...
    }
}

export interface Mail extends Mail.Application {
    // Element collections
    accounts: Mail.Account[] & ElementAccess<Mail.Account>;
    mailboxes: Mail.Mailbox[] & ElementAccess<Mail.Mailbox>;
    messageViewers: Mail.MessageViewer[] & ElementAccess<Mail.MessageViewer>;
    signatures: Mail.Signature[] & ElementAccess<Mail.Signature>;
    rules: Mail.Rule[] & ElementAccess<Mail.Rule>;
}

interface ElementAccess<T> {
    byName(name: string): T;
    byId(id: string | number): T;
    at(index: number): T;
    whose(filter: Record<string, unknown>): T[];
}
```

---

## 16. Limitations and Gaps

### Fundamental Limitations of the JXA Bridge

1. **Process-per-call**: Every `run()` call spawns a new osascript process. There is no way
   to maintain state between calls without the REPL's accumulation approach.

2. **Serialization boundary**: Functions passed to `run()` cannot access Node.js modules,
   closures, or complex objects. Only JSON-serializable values cross the boundary.

3. **No async in JXA**: JXA itself is synchronous. Long-running operations block the
   osascript process entirely.

4. **Apple Security**: Recent macOS versions require user approval for automation. Apps
   must be granted Accessibility permissions. System Integrity Protection may block
   certain operations.

5. **No event handling**: JXA can respond to Apple Events but the run() bridge has no
   mechanism for receiving events or callbacks from the JXA side.

### Type System Gaps

1. **Enumerations**: SDEF defines many `<enumeration>` types (e.g., message format options,
   sort directions, account types). These are all ignored, resulting in `any` types.

2. **Element specifiers**: The core JXA pattern is `app.mailboxes.byName("INBOX").messages()`.
   These element collections and their `byName`, `byId`, `at`, `whose` accessors have no types.

3. **Value types**: Apple-specific value types (RGB color, point, rectangle, bounds, alias, file)
   are all `any`.

4. **Responds-to commands**: SDEF `<responds-to>` elements that indicate which commands
   a class supports are not used.

5. **Access modifiers**: Properties with `access="r"` (read-only) are not marked `readonly`.

6. **Value class**: SDEF `<value-type>` elements are not processed.

7. **Cocoa class references**: SDEF `<cocoa>` elements with `class` attributes that map
   to Objective-C classes are not used.

### Dependency Concerns

| Dependency | Issue |
|------------|-------|
| `@rgrove/parse-xml@1` | Last major version is v4. v1 may have edge cases. |
| `json-schema-to-typescript@5` | Current is v15. Major API changes possible. |
| `camelcase@5` | Works but is now ESM-only in v7+. |
| `meow@9` | Works but is now ESM-only in v12+. |
| `macos-version@5` | Works but may not recognize newest macOS versions. |
| `indent-string@3` | Now ESM-only in v5+. |

---

## 17. Alternative Approaches and Related Projects

### Related JXA-from-Node Projects

| Project | Approach | Status |
|---------|----------|--------|
| [sindresorhus/run-jxa](https://github.com/sindresorhus/run-jxa) | Similar osascript bridge | Active, simpler API |
| [wtfaremyinitials/osa2](https://github.com/wtfaremyinitials/osa2) | osascript with caching | Inactive |
| [nicolo-ribaudo/jxa](https://github.com/nicolo-ribaudo/jxa) | Type-safe JXA | Limited |

### Alternative Type Generation

1. **Script Editor's dictionary viewer**: macOS Script Editor can export sdef files
   via File > Export... as an alternative to the `sdef` command.

2. **Swift's NSAppleScript**: Could be used as an alternative to osascript for better
   performance and error handling.

3. **Apple's JavaScript bridge**: The `JavaScriptCore` framework could potentially be used
   directly for tighter integration.

### For GenesisTools Specifically

The most practical path is:

1. **Fork `@jxa/sdef-to-dts`** as a local module in `src/jxa/lib/sdef-parser.ts`
2. **Rewrite `@jxa/run`** using `Bun.spawn` in `src/jxa/lib/executor.ts`
3. **Enhance type generation** incrementally (enums first, then collections)
4. **Ship pre-generated types** for the most useful apps (Finder, Mail, Safari,
   System Events, Terminal, Notes, Reminders, Calendar)
5. **Build CLI commands** following the GenesisTools pattern (commander, @clack/prompts)

The upstream project is MIT-licensed and relatively stable (last release April 2025).
It provides a solid foundation but the type generation quality is the main area where
we can add significant value.

---

## Appendix A: File Index

### @jxa/sdef-to-dts
```
packages/@jxa/sdef-to-dts/
  src/sdef-to-dts.ts          # Core transform function (321 lines)
  bin/cmd.js                   # CLI entry point (83 lines)
  test/fixtures-test.ts        # Snapshot tests
  test/example.ts              # Type example
  test/fixtures/
    StandardAdditions/          # input.sdef + output.ts + output.json
    System Events/              # input.sdef + output.ts + output.json
```

### @jxa/run
```
packages/@jxa/run/
  src/run.ts                   # Core run/runJXACode (127 lines)
  test/run-test.ts             # Tests
```

### @jxa/types
```
packages/@jxa/types/
  src/index.d.ts               # Re-exports all types
  src/Application.d.ts         # Application function + namespace (230 lines)
  src/Automation.d.ts           # Automation namespace
  src/ObjectSpecifier.d.ts      # ObjectSpecifier namespace
  src/core/                     # 25 generated .d.ts files
  tools/sdef-to-dts.js          # Type regeneration script
  tools/sdefs/                  # 25 .sdef source files
  test/type-test.ts             # Generic type usage test
  test/fixtures/GoogleChrome.d.ts  # Example custom app types
```

### @jxa/global-type
```
packages/@jxa/global-type/
  src/index.d.ts               # Global augmentation (23 lines)
  src/index.js                 # Empty file (needed for import)
  test/fixtures/               # ~100 JXA example files
  tool/download.js             # Downloads test fixtures from openspc2.org
```

### @jxa/repl
```
packages/@jxa/repl/
  src/repl.ts                  # REPL implementation (39 lines)
  src/cli.ts                   # CLI entry point (6 lines)
  bin/cmd.js                   # Binary entry point
```

---

## Appendix B: SDEF Type Mapping Reference

This table shows how SDEF types are currently mapped, and what they should be:

| SDEF Type | Current Mapping | Ideal Mapping |
|-----------|----------------|---------------|
| `text` | `string` | `string` |
| `number` | `number` | `number` |
| `integer` | `number` | `number` |
| `boolean` | `boolean` | `boolean` |
| `Any` | `any` | `unknown` |
| `type class` | `any` | `string` (type name) |
| `RGB color` | `any` | `[number, number, number]` |
| `point` | `any` | `{ x: number, y: number }` |
| `rectangle` | `any` | `{ x: number, y: number, w: number, h: number }` |
| `alias` | `any` | `string` (POSIX path) |
| `file` | `any` | `string` (POSIX path) |
| `date` | `any` | `Date` |
| `record` | `any` | `Record<string, unknown>` |
| `list` | `any` | `unknown[]` |
| custom class ref | `any` or `Namespace.ClassName` | `Namespace.ClassName` |

---

## Appendix C: Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| 0.2.0 | 2018-04-15 | Initial release: sdef-to-dts, types, global-type, run |
| 1.0.1 | 2018-06-24 | First stable release |
| 1.1.0 | 2018-06-25 | Added @jxa/repl |
| 1.2.0 | 2018-09-05 | `Application<T>()` generics support |
| 1.3.0 | 2018-09-06 | sdef-to-dts CLI binary |
| 1.3.2 | 2019-10-29 | Buffer increased to 100MB |
| 1.3.4 | 2020-10-08 | Finder URL type fix |
| 1.3.5 | 2022-04-18 | meow dependency update |
| 1.3.6 | 2022-08-21 | Fix circular import in global-type |
| 1.4.0 | 2025-04-06 | Class inheritance (`extends`) support |

---

## Appendix D: Quick Reference -- Common Patterns

### Get Current User

```typescript
import "@jxa/global-type";
import { run } from "@jxa/run";

const username = await run(() =>
    Application("System Events").currentUser().name()
);
```

### List Running Apps

```typescript
const apps = await run(() => {
    const sys = Application("System Events");
    return sys.processes().map(p => p.name());
});
```

### Send Notification

```typescript
await run((title, body) => {
    const app = Application.currentApplication();
    app.includeStandardAdditions = true;
    app.displayNotification(body, { withTitle: title });
}, "Alert", "Something happened");
```

### Get Safari URLs

```typescript
const urls = await run(() => {
    const safari = Application("Safari");
    return safari.windows().flatMap(w =>
        w.tabs().map(t => ({ title: t.name(), url: t.URL() }))
    );
});
```

### Read Mail

```typescript
const unread = await run(() => {
    const mail = Application("Mail");
    const inbox = mail.inbox();
    return inbox.messages.whose({ readStatus: false })().map(m => ({
        from: m.sender(),
        subject: m.subject(),
        date: m.dateReceived().toISOString(),
    }));
});
```

### Execute Shell Command via JXA

```typescript
const output = await run((cmd) => {
    const app = Application.currentApplication();
    app.includeStandardAdditions = true;
    return app.doShellScript(cmd);
}, "ls -la /tmp");
```

### Create a Note

```typescript
await run((title, body) => {
    const notes = Application("Notes");
    const note = notes.Note({
        name: title,
        body: `<h1>${title}</h1><p>${body}</p>`
    });
    notes.defaultAccount().folders.byName("Notes").notes.push(note);
}, "My Note", "Hello from Node.js");
```

### Finder: Get Selected Files

```typescript
const selected = await run(() => {
    const finder = Application("Finder");
    return finder.selection().map(item => item.url());
});
```

---

*Document generated: 2026-02-16*
*Source: https://github.com/JXA-userland/JXA (commit depth=1, v1.4.0)*
*Explored by: GenesisTools documentation system*
