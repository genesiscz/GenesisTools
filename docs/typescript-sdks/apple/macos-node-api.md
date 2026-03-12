# @nativescript/macos-node-api — Comprehensive Reference

> **Repository:** [NativeScript/runtime-node-api](https://github.com/NativeScript/runtime-node-api) (42 stars)
> **npm:** `@nativescript/macos-node-api` (v0.4.0 published, repo at 0.1.4)
> **License:** MIT
> **Language breakdown:** C 47%, Assembly 11%, C++ 10%, Shell 10%, TeX 9%
> **Contributors:** DjDeveloperr, Nathan Walker, Jamie Birch (shirakaba)

An embeddable, engine-agnostic NativeScript runtime based on **Node-API** and **libffi**. Gives Node.js and Deno **full access to every Objective-C macOS API** — AppKit, Vision, NaturalLanguage, Metal, SpriteKit, CoreML, and 50+ more frameworks — with auto-generated TypeScript type definitions.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Installation](#installation)
3. [Core API Surface](#core-api-surface)
4. [Available Frameworks (56)](#available-frameworks-56)
5. [Code Examples](#code-examples)
6. [TypeScript Type Generation](#typescript-type-generation)
7. [Performance](#performance)
8. [Compatibility](#compatibility)
9. [Known Limitations](#known-limitations)
10. [Comparison with Alternatives](#comparison-with-alternatives)
11. [Related Projects](#related-projects)

---

## Architecture

### How It Works

```
┌─────────────────────────────────────────────────────┐
│ TypeScript / JavaScript                              │
│   import '@nativescript/macos-node-api'              │
│   objc.import('Vision')                             │
│   VNRecognizeTextRequest.alloc().init()             │
├─────────────────────────────────────────────────────┤
│ Node-API (engine-agnostic)                          │
│   process.dlopen() → NativeScript.node              │
├─────────────────────────────────────────────────────┤
│ NativeScript Runtime (C/C++)                        │
│   Binary metadata (.nsmd) → lazy binding creation   │
│   libffi for dynamic Objective-C calls              │
│   Objective-C runtime (class_addMethod, etc.)       │
├─────────────────────────────────────────────────────┤
│ Apple Frameworks                                    │
│   AppKit, Vision, Metal, CoreML, Foundation, ...    │
└─────────────────────────────────────────────────────┘
```

1. **Metadata Generator** — A clang-based tool (`MetadataGenerator`) reads all public Objective-C headers from Apple SDK frameworks using clang's `RecursiveASTVisitor`. Produces:
   - Binary metadata files (`.nsmd`) per architecture (arm64, x86_64)
   - TypeScript type definitions (`.d.ts`) per framework

2. **Native Runtime Library** — A C/C++ shared library (`NativeScript.node`) built with CMake that:
   - Loads binary metadata as a memory-mapped mach-o section (`__DATA __TNSMetadata`)
   - Uses **libffi** for dynamic function calls into Objective-C
   - Exposes all discovered APIs as JavaScript objects via **Node-API**
   - Handles memory management, type marshalling, and ObjC runtime integration

3. **Engine Independence** — Works with any JS engine implementing Node-API:
   - **Node.js** (V8)
   - **Deno** (V8)
   - **Hermes** (React Native)
   - **QuickJS**
   - **JavaScriptCore**

4. **Lazy Binding** — Bindings are created on first access, not at startup. Only frameworks you `objc.import()` get loaded.

---

## Installation

### For Node.js

```bash
npm install @nativescript/macos-node-api
# or
bun add @nativescript/macos-node-api
```

### For Deno

```json
// deno.json
{
  "imports": {
    "@nativescript/macos-node-api": "npm:@nativescript/macos-node-api@^0.1.0"
  }
}
```

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ES2022",
    "moduleResolution": "Node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  }
}
```

### Building from Source

```bash
git clone https://github.com/NativeScript/runtime-node-api.git
cd runtime-node-api
npm install

# 1. Build metadata generator (downloads LLVM, uses cmake)
deno task build-metagen

# 2. Generate metadata + TypeScript types for macOS
deno task metagen macos
# Outputs: metadata/metadata.macos.{arm64,x86_64}.nsmd
#          packages/macos/types/*.d.ts

# 3. Build runtime
deno task build macos
# Outputs: packages/macos/dist/macos/NativeScript.node
```

---

## Core API Surface

### `objc` Namespace

```typescript
namespace objc {
  function import(framework: string): void;         // Load a framework dynamically
  function registerClass(cls: Function): void;       // Alternative to NativeClass
  function registerBlock(encoding: string, fn: T): T; // Register an ObjC block
  function autoreleasepool(fn: () => T): T;          // Autorelease pool scope
  function getArrayBuffer(ptr: Pointer, size: number): ArrayBuffer;
}
```

### `NativeClass(cls)`

Registers a JavaScript class with the Objective-C runtime:

```typescript
function NativeClass(cls: Function): void;
```

### `interop` Namespace

```typescript
namespace interop {
  // Primitive types for FFI
  const types: {
    void, bool, int8, uint8, int16, uint16, int32, uint32,
    int64, uint64, float, double, UTF8CString, unichar,
    id, protocol, class, SEL, pointer
  };

  class Pointer implements PointerObject {
    constructor(address: number);
    add(offset: number): Pointer;
    subtract(offset: number): Pointer;
    toNumber(): number;
  }

  class Reference<T> implements PointerObject {
    value: T;
    constructor(value: T);
    constructor(type: Type, value: T);
    constructor(type: Type, pointer: Pointer);
  }

  function addMethod(constructor, method): void;   // Add method after registration
  function addProtocol(constructor, protocol): void;
  function adopt(ptr: Pointer): Pointer;           // Take ownership
  function free(ptr: Pointer): void;
  function sizeof(obj: unknown): number;
  function alloc(size: number): Pointer;
  function handleof(obj: unknown): Pointer;
  function bufferFromData(data: NativeObject): ArrayBuffer;
}
```

### Static Class Properties for ObjC Integration

```typescript
class MyClass extends NSObject {
  // Declare which ObjC protocols this class implements
  static ObjCProtocols = [NSApplicationDelegate, NSWindowDelegate];

  // Expose methods with explicit type encodings
  static ObjCExposedMethods = {
    myMethod: { returns: interop.types.void, params: [NSNotification] }
  };

  // Register with ObjC runtime (must be in static initializer)
  static { NativeClass(this); }
}
```

---

## Available Frameworks (56)

All frameworks have auto-generated `.d.ts` files in `packages/macos/types/`:

| Category | Frameworks |
|----------|-----------|
| **UI/AppKit** | AppKit, WebKit, GLKit |
| **Graphics/Rendering** | CoreGraphics, CoreImage, Metal, MetalKit, MetalPerformanceShaders, OpenGL, QuartzCore, SceneKit, SpriteKit, ModelIO |
| **Media** | AVFoundation, AVFAudio, AudioToolbox, CoreAudio, CoreAudioTypes, CoreMedia, CoreVideo, CoreMIDI, MediaToolbox, ImageIO |
| **ML/AI** | CoreML, MLCompute, NaturalLanguage, GameplayKit |
| **Data/Storage** | CoreData, CoreFoundation, Foundation, CloudKit, CoreSpotlight, DiskArbitration, UniformTypeIdentifiers |
| **Location/Motion** | CoreLocation, CoreMotion, MapKit |
| **Contacts/Calendar** | Contacts, AddressBook, EventKit |
| **System** | IOKit, IOSurface, Security, CoreServices, CoreText, CoreHaptics, ScreenCaptureKit |
| **Gaming** | SpriteKit, SceneKit, GameController, GameKit, GameplayKit |
| **Communication** | CoreBluetooth, Intents, UserNotifications |
| **Other** | JavaScriptCore, Symbols |

**Foundation and AppKit are loaded automatically.** Others need `objc.import()`:

```typescript
objc.import("Metal");
objc.import("NaturalLanguage");
objc.import("CoreML");
objc.import("ScreenCaptureKit");
```

**Missing from auto-generated types** (may still work via `objc.import()` if they have ObjC headers):
Vision, ARKit, RealityKit, StoreKit, HealthKit, HomeKit, NetworkExtension, CryptoKit, PassKit, Photos, PhotosUI, PDFKit, Virtualization.

---

## Code Examples

### Basic Foundation Usage

```typescript
import "@nativescript/macos-node-api";

console.log(NSProcessInfo.processInfo.operatingSystemVersionString);
console.log(NSDate.date());

const arr = NSMutableArray.arrayWithCapacity(1);
arr.insertObjectAtIndex(NSObject.new(), 0);

const dict = NSMutableDictionary.dictionary();
dict.setObjectForKey(NSObject.new(), "key");
for (const key of dict) { console.log(key); }

// Pointer operations
const ptr = new interop.Pointer(1);
const ref = new interop.Reference(interop.types.int32, 1);
ref.value = 42;
```

### AppKit Window Application

```typescript
import "@nativescript/macos-node-api";
objc.import("AppKit");

class AppDelegate extends NSObject {
  static ObjCProtocols = [NSApplicationDelegate];
  static { NativeClass(this); }

  applicationDidFinishLaunching(_notification: NSNotification) {
    const window = NSWindow.alloc().initWithContentRectStyleMaskBackingDefer(
      { origin: { x: 0, y: 0 }, size: { width: 500, height: 500 } },
      NSWindowStyleMask.Titled | NSWindowStyleMask.Closable | NSWindowStyleMask.Resizable,
      2, false
    );
    window.title = "Hello from Node.js";
    window.makeKeyAndOrderFront(NSApp);
  }
}

const NSApp = NSApplication.sharedApplication;
NSApp.setActivationPolicy(NSApplicationActivationPolicy.Regular);
NSApp.delegate = AppDelegate.new();
NSApplicationMain(0, null);
```

### Vision OCR

```typescript
import "@nativescript/macos-node-api";
objc.import("Vision");

const request = VNRecognizeTextRequest.alloc().init();
request.recognitionLevel = VNRequestTextRecognitionLevel.Accurate;

const handler = VNImageRequestHandler.alloc().initWithURLOptions(
  NSURL.fileURLWithPath("/tmp/image.png"),
  null,
);
handler.performRequestsError([request], null);

const results = request.results as VNRecognizedTextObservation[];
for (const obs of results) {
  console.log(obs.topCandidates(1)[0].string);
}
```

### MLCompute (GPU Machine Learning)

```typescript
import "@nativescript/macos-node-api";
objc.import("MLCompute");

const shape = [1, 28, 28, 1];
const tInput = MLCTensor.tensorWithShapeDataType(shape, MLCDataType.Float32);
const tWeights = MLCTensor.tensorWithShapeRandomInitializerTypeDataType(
  [1, 784, 128, 1], MLCRandomInitializerType.GlorotUniform, MLCDataType.Float32
);
const graph = MLCGraph.new();
const device = MLCDevice.gpuDevice();
const inference = MLCInferenceGraph.graphWithGraphObjects([graph]);
inference.addInputs({ input: tInput });
inference.compileWithOptionsDevice(MLCGraphCompilationOptions.DebugLayers, device);
inference.executeWithInputsDataBatchSizeOptionsCompletionHandler(
  { input: dataInput }, 1, MLCExecutionOptions.Synchronous, (output, error, time) => {
    console.log(output, error, time);
  }
);
```

### CADisplayLink Animation Driver

```typescript
import "@nativescript/macos-node-api";
objc.import("AppKit");

class AnimDriver extends NSObject {
  static ObjCExposedMethods = {
    tick: { returns: interop.types.void, params: [] },
  };
  static { NativeClass(this); }

  tick() { /* called every frame */ }

  start() {
    const displayLink = NSScreen.mainScreen.displayLinkWithTargetSelector(this, "tick");
    displayLink.addToRunLoopForMode(NSRunLoop.currentRunLoop, NSDefaultRunLoopMode);
    displayLink.preferredFrameRateRange = { minimum: 90, maximum: 120, preferred: 120 };
  }
}
```

### Dynamic Method Addition (Post-Registration)

```typescript
// Add a method to a class AFTER it's been registered:
interop.addMethod(
  AppDelegate,
  function applicationDidFinishLaunching(_notification: NSNotification) {
    // 'this' refers to the ObjC instance
    console.log("App launched!");
  },
);
```

---

## TypeScript Type Generation

The type generation pipeline:

1. **Build metadata generator** (`deno task build-metagen`):
   - Downloads LLVM
   - Compiles C++ metadata generator with CMake
   - Binary: `metadata/build/Release/MetadataGenerator`

2. **Run generation** (`deno task metagen macos`):
   - Scans all Apple SDK headers via clang's HeaderSearch + RecursiveASTVisitor
   - For each declaration (class, protocol, enum, struct, function, constant) → Meta instance
   - Serializes to binary `.nsmd` files (per architecture: arm64, x86_64)
   - Generates TypeScript `.d.ts` files per framework

3. **Result**: ~56 `.d.ts` files with full type coverage, giving autocomplete and type-checking.

---

## Performance

- **libffi** provides dynamic function calling with minimal overhead
- Metadata loaded as memory-mapped mach-o section — no deserialization
- Bindings lazily created on first access
- Node-API layer adds minimal overhead vs direct V8/JSC calls
- Competitive with or faster than the old V8-direct NativeScript runtime
- No JIT-specific optimizations — performance depends on JS engine

---

## Compatibility

| Dimension | Support |
|-----------|---------|
| **macOS versions** | 10.15+ (based on SDK availability) |
| **Architectures** | arm64 (Apple Silicon) and x86_64 (Intel) |
| **Node.js** | Supported (primary target, uses `process.dlopen`) |
| **Deno** | Supported (native, with bundled app support) |
| **Bun** | Untested / uncertain (depends on Node-API compat) |
| **React Native** | Integration in progress (via Node-API / Hermes) |
| **iOS** | Separate package: `@nativescript/ios-node-api` |
| **Package format** | ESM (`"type": "module"`) |

---

## Known Limitations

| Limitation | Details |
|------------|---------|
| **Objective-C only** | No direct Swift API access. Swift APIs with `@objc` bridging work. Pure Swift APIs (SwiftUI, Swift Concurrency) don't. |
| **No Swift-only APIs** | Many post-2020 Apple APIs are Swift-only (SwiftUI, SwiftData, WidgetKit). Use `node-swift` for those. |
| **Event loop integration** | When using `NSApplicationMain`, special handling needed to keep Node.js event loop alive. |
| **Missing framework types** | Vision, ARKit, RealityKit, Photos, PDFKit etc. may work but lack auto-generated `.d.ts`. |
| **Pre-1.0** | npm shows v0.4.0 but repo says 0.1.4. API may change. |
| **Build complexity** | Building from source requires LLVM, cmake, and deno. Pre-built npm package includes compiled `.node` addon. |
| **No Bun guarantee** | Loader uses `process.dlopen()` which is Node.js-specific. |

---

## Comparison with Alternatives

| Feature | @nativescript/macos-node-api | NodObjC | node-swift | ffi-napi | lukaskollmer/objc |
|---------|---------------------------|---------|------------|----------|-------------------|
| **Approach** | Auto-generated from SDK headers | Manual ObjC runtime + BridgeSupport | Swift → Node module | Generic FFI | Manual ObjC runtime + ffi-napi |
| **Type Safety** | Full auto-generated TS types | None | Manual (you write Swift) | None | Partial |
| **API Coverage** | 56+ frameworks automatically | Manual per-API | Per-module | Manual per-API | Manual per-API |
| **Maintenance** | Active (2024–2025) | Dead (2014) | Active (2025) | Community maintained | Unmaintained (2022) |
| **Engine Support** | Node, Deno, Hermes, QuickJS, JSC | Node only | Node only | Node only | Node only |
| **Class Subclassing** | Native (`static { NativeClass(this) }`) | Limited | N/A (Swift side) | N/A | Limited |
| **Protocol Support** | Full (`static ObjCProtocols`) | Manual | N/A | N/A | Manual |
| **Swift-only APIs** | No | No | Yes | No | No |
| **Performance** | Near-native via libffi | Overhead from runtime lookups | Native Swift | High overhead | Overhead from ffi-napi |

**Key advantage:** Auto-generated bindings for the entire macOS SDK with full TypeScript types. All alternatives require manual, per-API bridging.

**When to use node-swift instead:** When you need Swift-only APIs (SwiftUI, SwiftData, WidgetKit, Apple Foundation Models).

---

## Related Projects

- **`@nativescript/ios-node-api`** — iOS sibling package
- **`@nativescript/objc-node-api`** — Shared ObjC runtime type definitions
- **[NSBall](https://github.com/DjDeveloperr/NSBall)** — Full example app (bouncing ball with AppKit + SpriteKit)
- **[nativescript-macos-solid](https://github.com/ammarahm-ed/nativescript-macos-solid)** — SolidJS integration for macOS native apps
- **[NativeScript/napi-android](https://github.com/NativeScript/napi-android)** — Android runtime using same Node-API approach
