# TypeScript / Node.js SDKs for Apple Frameworks

A curated list of GitHub repos and npm packages that bridge TypeScript/Node.js to Apple's native macOS/iOS SDKs — Vision, NaturalLanguage, EventKit, Contacts, LocalAuthentication, and more.

---

## Table of Contents

- [Vision Framework (OCR / Computer Vision)](#vision-framework)
- [NaturalLanguage + Vision via Subprocess](#naturallanguage--vision-via-subprocess)
- [EventKit (Calendar & Reminders)](#eventkit-calendar--reminders)
- [Contacts Framework](#contacts-framework)
- [LocalAuthentication (Touch ID / Face ID)](#localauthentication-touch-id--face-id)
- [Full Apple SDK Access (Runtimes & Bridges)](#full-apple-sdk-access-runtimes--bridges)
- [React Native Bridges (iOS / visionOS)](#react-native-bridges)
- [Generic FFI](#generic-ffi)
- [Quick Comparison](#quick-comparison)

---

## Vision Framework

### `@cherrystudio/mac-system-ocr`

> **GitHub**: [DeJeune/mac-system-ocr](https://github.com/DeJeune/mac-system-ocr)
> **npm**: `@cherrystudio/mac-system-ocr`
> **Language**: Objective-C++ native addon
> **Status**: Active (2024–2025)

A high-performance OCR Node.js native addon built on top of Apple's Vision Framework (`VNRecognizeTextRequest`). Wraps the Vision API directly — no Tesseract, no cloud.

**Features:**
- On-device OCR via `VNRecognizeTextRequest`
- Multi-language support (`en-US`, `zh-Hans`, `zh-Hant`, `ja-JP`, …)
- Per-word bounding boxes with normalized coordinates (bottom-left origin)
- Batch image recognition
- Buffer-based input (no disk write needed)
- Electron-builder compatible

**Install:**
```bash
npm install @cherrystudio/mac-system-ocr
```

**Usage:**
```typescript
import MacOCR from '@cherrystudio/mac-system-ocr';

// Basic OCR
const result = await MacOCR.recognizeFromPath('screenshot.png');
console.log(result.text);
console.log(result.confidence); // 0.0–1.0

// With options + bounding boxes
const result = await MacOCR.recognizeFromPath('document.jpg', {
  languages: 'en-US, zh-Hans',
  recognitionLevel: MacOCR.RECOGNITION_LEVEL_ACCURATE,
  minConfidence: 0.5,
});

result.observations.forEach(obs => {
  console.log(`"${obs.text}" at (${obs.x}, ${obs.y}) — ${obs.confidence}`);
});

// From buffer
const buf = fs.readFileSync('image.png');
const result = await MacOCR.recognizeFromBuffer(buf);

// Batch
const results = await MacOCR.recognizeBatchFromPath(['a.png', 'b.png']);
```

**TypeScript types:**
```typescript
interface RecognizeOptions {
  languages?: string;                  // comma-separated BCP-47 codes
  recognitionLevel?: 0 | 1;           // 0 = fast, 1 = accurate
  minConfidence?: number;              // 0.0–1.0
}
interface TextObservation {
  text: string;
  confidence: number;
  x: number; y: number; width: number; height: number; // normalized, bottom-left origin
}
interface OCRResult {
  text: string;
  confidence: number;
  observations: TextObservation[];
}
```

**Requirements:** macOS 10.15+, Node.js 18+, Xcode CLI tools

---

## NaturalLanguage + Vision via Subprocess

### `darwinkit`

> **GitHub**: [0xMassi/darwinkit](https://github.com/0xMassi/darwinkit)
> **Install**: `brew install darwinkit` or binary download
> **Language**: Swift CLI, called from any language via JSON-RPC over stdio
> **Status**: Active (2025), MIT

A Swift CLI that exposes Apple's **NaturalLanguage** and **Vision** frameworks via JSON-RPC 2.0 over stdio — no API keys, fully on-device. Spawn it as a subprocess from TypeScript/Node.js.

**Supported methods:**

| Method | Apple Framework | Description |
|--------|----------------|-------------|
| `nlp.embed` | `NLEmbedding` | 512-dim semantic text vectors |
| `nlp.distance` | `NLEmbedding` | Cosine distance between texts |
| `nlp.neighbors` | `NLEmbedding` | Semantically similar words |
| `nlp.tag` | `NLTagger` | POS tags, NER, lemmatization |
| `nlp.sentiment` | `NLTagger` | Sentiment analysis |
| `nlp.language` | `NLLanguageRecognizer` | Language detection |
| `vision.ocr` | `VNRecognizeTextRequest` | OCR from image file |
| `system.capabilities` | — | Available methods + OS info |

**Roadmap:** `speech.transcribe` (SFSpeechRecognizer), `llm.generate` (Apple Foundation Models)

**TypeScript client (copy-paste ready):**
```typescript
import { spawn } from 'child_process';
import * as readline from 'readline';

class DarwinKit {
  private process;
  private rl;
  private pending = new Map<string, { resolve: Function; reject: Function }>();
  private nextId = 1;

  constructor() {
    this.process = spawn('darwinkit', ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = readline.createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (!msg.id) return; // skip notifications
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    });
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = String(this.nextId++);
    this.process.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() { this.process.stdin!.end(); }
}

// Usage
const dk = new DarwinKit();

const sentiment = await dk.call<{ score: number; label: string }>('nlp.sentiment', {
  text: 'I love this!',
});
// → { score: 1.0, label: 'positive' }

const lang = await dk.call<{ language: string; confidence: number }>('nlp.language', {
  text: 'Bonjour le monde',
});
// → { language: 'fr', confidence: 0.999 }

const ocr = await dk.call<{ text: string; blocks: unknown[] }>('vision.ocr', {
  path: '/tmp/screenshot.png',
  languages: ['en-US'],
  level: 'accurate',
});
// → { text: '...', blocks: [...] }

const embed = await dk.call<{ vector: number[]; dimension: number }>('nlp.embed', {
  text: 'quarterly meeting notes',
  language: 'en',
  type: 'sentence',
});
// → { vector: [...512 floats...], dimension: 512 }

dk.close();
```

**Requirements:** macOS 13+ (Ventura), sentence embeddings require macOS 11+

---

## EventKit (Calendar & Reminders)

### `eventkit-node`

> **GitHub**: [dacay/eventkit-node](https://github.com/dacay/eventkit-node)
> **npm**: `eventkit-node`
> **Language**: Objective-C++ native addon
> **Status**: Active, MPL-2.0

Full CRUD access to macOS Calendars and Reminders via Apple's **EventKit** framework.

**Install:**
```bash
npm install eventkit-node
```

**Capabilities:**
- Request permissions (`NSCalendarsUsageDescription` in Info.plist required)
- CRUD for calendars, events, and reminders
- Query with predicates (date range, completion status)
- Source management (iCloud, Exchange, local)
- Event store commit/reset

**Usage:**
```typescript
import {
  requestFullAccessToEvents,
  requestFullAccessToReminders,
  getCalendars,
  createEventPredicate,
  getEventsWithPredicate,
  saveEvent,
  removeEvent,
  saveReminder,
  getRemindersWithPredicate,
  createReminderPredicate,
} from 'eventkit-node';

// Request permissions
const granted = await requestFullAccessToEvents();

// List calendars
const calendars = getCalendars('event');
console.log(calendars.map(c => c.title));

// Query events in a date range
const predicate = createEventPredicate(
  new Date('2025-01-01').getTime(),
  new Date('2025-12-31').getTime(),
);
const events = getEventsWithPredicate(predicate);

// Create an event
saveEvent({
  title: 'Team standup',
  startDate: new Date('2025-03-01T09:00:00').getTime(),
  endDate: new Date('2025-03-01T09:30:00').getTime(),
  calendarIdentifier: calendars[0].calendarIdentifier,
}, 'thisEvent', true);

// Reminders
await requestFullAccessToReminders();
const reminderPredicate = createReminderPredicate();
const reminders = await getRemindersWithPredicate(reminderPredicate);
```

**Requirements:** macOS 10.15+, Node.js 14+, Xcode CLI tools

---

## Contacts Framework

### `node-mac-contacts`

> **GitHub**: [codebytere/node-mac-contacts](https://github.com/codebytere/node-mac-contacts)
> **npm**: `node-mac-contacts`
> **Language**: Objective-C++ native addon (by Electron core team member)
> **Status**: Stable

Full CRUD access to macOS Contacts via Apple's **CNContactStore** framework. Includes a live `EventEmitter` for contact-change events.

**Install:**
```bash
npm install node-mac-contacts
```

**Usage:**
```typescript
import contacts from 'node-mac-contacts';

// Check / request permissions
const status = contacts.getAuthStatus();
// → 'Not Determined' | 'Denied' | 'Authorized' | 'Restricted'

await contacts.requestAccess();

// Read all contacts
const all = contacts.getAllContacts(['jobTitle', 'organizationName']);
// → [{ firstName, lastName, emailAddresses, phoneNumbers, ... }]

// Search
const results = contacts.getContactsByName('Appleseed');

// Create
contacts.addNewContact({
  firstName: 'Jane',
  lastName: 'Doe',
  emailAddresses: ['jane@example.com'],
  phoneNumbers: ['+14155550100'],
});

// Update / delete
contacts.updateContact({ firstName: 'Jane', lastName: 'Doe', nickname: 'JD' });
contacts.deleteContact({ name: 'Jane Doe' });

// Listen for changes
contacts.listener.setup();
contacts.listener.on('contact-changed', (external: boolean) => {
  console.log('Contact changed externally:', external);
});
contacts.listener.remove();
```

**Requirements:** macOS, `NSContactsUsageDescription` in Info.plist

---

### `@appkit/apple-contacts`

> **GitHub**: [appkitstudio/apple-contacts](https://github.com/appkitstudio/apple-contacts)
> **npm**: `@appkit/apple-contacts`
> **Language**: Pure TypeScript (reads SQLite database directly)
> **Status**: Active (Jan 2026), MIT

Read-only access to the macOS Contacts database via direct SQLite access — **no native build required**. Only needs `better-sqlite3`. Requires Full Disk Access permission.

**Install:**
```bash
npm install @appkit/apple-contacts
```

**Usage:**
```typescript
import { ContactsClient } from '@appkit/apple-contacts';

const client = new ContactsClient();
client.connect();

// All contacts
const all = await client.getAllContacts({ includeEmails: true, includePhones: true });

// Search
const results = await client.searchContacts('John');

// By organization
const org = await client.getContactsByOrganization('Acme Corp');

// With birthdays
const bday = await client.getContactsWithBirthdays();

// Find by email / phone
const byEmail = await client.findContactsByEmail('jane@example.com');
const byPhone = await client.findContactsByPhone('555-1234');

// Stats
const stats = await client.getStats();
console.log(stats.totalContacts, stats.totalEmails);

client.disconnect();
```

**Trade-offs vs. `node-mac-contacts`:**
- ✅ No native build / node-gyp
- ✅ Faster (direct SQL, no IPC)
- ❌ Read-only
- ❌ Requires Full Disk Access (not standard Contacts permission)

**Database path:** `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb`

---

## LocalAuthentication (Touch ID / Face ID)

### `node-mac-auth`

> **GitHub**: [codebytere/node-mac-auth](https://github.com/codebytere/node-mac-auth)
> **npm**: `node-mac-auth`
> **Language**: Objective-C++ native addon
> **Status**: Active (v1.1.0, Jun 2024)

Exposes macOS biometric authentication (Touch ID / Face ID) to Node.js via the **LocalAuthentication** framework.

**Install:**
```bash
npm install node-mac-auth
```

**Usage:**
```typescript
import { canPromptTouchID, promptTouchID } from 'node-mac-auth';

if (canPromptTouchID()) {
  try {
    await promptTouchID({
      reason: 'Authenticate to access secure data',
      reuseDuration: 30, // seconds
    });
    console.log('Authenticated!');
  } catch (err) {
    console.error('Auth failed:', err);
  }
}
```

**Note:** Requires an app bundle context — works in Electron apps, not bare terminal scripts.

---

## Full Apple SDK Access (Runtimes & Bridges)

### `@nativescript/macos-node-api` ⭐ Most Powerful

> **GitHub**: [NativeScript/runtime-node-api](https://github.com/NativeScript/runtime-node-api)
> **npm**: `@nativescript/macos-node-api`
> **Language**: C / Objective-C++ runtime with TypeScript types auto-generated from Apple SDK metadata
> **Status**: Active (v0.1.x, 2024–2025), MIT

An embeddable, engine-agnostic NativeScript runtime that gives Node.js and Deno **full access to every macOS API** — AppKit, Vision, NaturalLanguage, Metal, SpriteKit, BNNS, CoreML, and more. TypeScript definitions are auto-generated from Apple's SDK metadata, so you get full type-checking.

**Install:**
```bash
npm install @nativescript/macos-node-api
```

**Usage example — accessing Apple Vision Framework:**
```typescript
import '@nativescript/macos-node-api';

objc.import('Vision');

// Use VNRecognizeTextRequest directly
const request = VNRecognizeTextRequest.alloc().init();
request.recognitionLevel = VNRequestTextRecognitionLevel.Accurate;

const handler = VNImageRequestHandler.alloc().initWithURLOptions(
  NSURL.fileURLWithPath('/tmp/image.png'),
  null,
);
handler.performRequestsError([request], null);

const results = request.results as VNRecognizedTextObservation[];
for (const obs of results) {
  console.log(obs.topCandidates(1)[0].string);
}
```

**Usage example — AppKit window:**
```typescript
import '@nativescript/macos-node-api';

objc.import('AppKit');

export class AppDelegate extends NSObject implements NSApplicationDelegate {
  static ObjCProtocols = [NSApplicationDelegate];
  static { NativeClass(this); }

  applicationDidFinishLaunching(_: NSNotification) {
    console.log(NSProcessInfo.processInfo.operatingSystemVersionString);
  }
}

const app = NSApplication.sharedApplication;
app.delegate = AppDelegate.new();
app.setActivationPolicy(NSApplicationActivationPolicy.Regular);
NSApplicationMain(0, null);
```

**Works with:** Node.js, Deno, Hermes, QuickJS — any JS engine with Node-API support.

**Requirements:** macOS (arm64 or x86_64), Xcode CLI tools to generate metadata

---

### `node-swift`

> **GitHub**: [kabiroberai/node-swift](https://github.com/kabiroberai/node-swift)
> **Language**: Swift + Node-API
> **Status**: Active, MIT

Write Node.js native modules in **Swift** and call them from TypeScript/JavaScript. Enables any Swift-only Apple API (e.g. WidgetKit, SwiftData) in Node.js. Memory-safe (ARC), idiomatic Swift syntax.

**Use case:** When you need a Swift-only API not available in Objective-C (many post-2020 Apple APIs are Swift-only).

**Example module (Swift):**
```swift
import NodeAPI
import Vision

#NodeModule(exports: [
  "recognizeText": try NodeFunction { (path: String) async throws -> String in
    let url = URL(fileURLWithPath: path)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let handler = try VNImageRequestHandler(url: url)
    try handler.perform([request])
    return request.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n") ?? ""
  }
])
```

**Call from TypeScript:**
```typescript
const { recognizeText } = require('./build/MyModule.node');
const text = await recognizeText('/tmp/image.png');
```

---

### `NodObjC` (Legacy)

> **GitHub**: [TooTallNate/NodObjC](https://github.com/TooTallNate/NodObjC)
> **npm**: `nodobjc`
> **Status**: ⚠️ Unmaintained (last commit ~2014), but historically important

The original Objective-C bridge for Node.js. Uses BridgeSupport files to dynamically expose the full Objective-C runtime and all Cocoa frameworks. Prefer `@nativescript/macos-node-api` for new projects.

```javascript
const $ = require('nodobjc');
$.framework('Foundation');
$.framework('Vision');
// ... access any ObjC API
```

---

## React Native Bridges

### `react-native-vision` (iOS — VisionKit + CoreML)

> **GitHub**: [rhdeck/react-native-vision](https://github.com/rhdeck/react-native-vision)
> **npm**: `react-native-vision`
> **Status**: Alpha / proof-of-concept

React Native wrapper for Apple's **VisionKit** and **CoreML**. Provides React components for live camera ML inference. iOS only.

**Components:** `VisionCamera`, `FaceCamera`, `GeneratorView` (style transfer), `RNVisionProvider/Consumer`

```typescript
import { VisionCamera } from 'react-native-vision';

export default () => (
  <VisionCamera style={{ flex: 1 }} classifier="MobileNet">
    {({ label, confidence }) => (
      <Text>{label}: {(confidence * 100).toFixed(0)}%</Text>
    )}
  </VisionCamera>
);
```

---

### `react-native-visionos`

> **GitHub**: [callstack/react-native-visionos](https://github.com/callstack/react-native-visionos)
> **Status**: Active (Callstack)

React Native with full **visionOS** platform SDK support for building Apple Vision Pro apps in TypeScript/React.

---

## Generic FFI

### `ffi-napi` (node-ffi-napi)

> **GitHub**: [node-ffi-napi/node-ffi-napi](https://github.com/node-ffi-napi/node-ffi-napi)
> **npm**: `ffi-napi`
> **Status**: Active, MIT

Load and call any dynamic library from Node.js without writing C++. Can call Apple's C-level APIs (CoreFoundation, CoreGraphics, etc.) directly.

```typescript
import ffi from 'ffi-napi';

const CoreFoundation = ffi.Library('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', {
  'CFStringCreateWithCString': ['pointer', ['pointer', 'string', 'uint32']],
});
```

**Warning:** Low-level, easy to segfault. Use only when no higher-level binding exists.

---

## Quick Comparison

| Repo / Package | Apple Framework | Type | Active | No Build? |
|---|---|---|---|---|
| `@cherrystudio/mac-system-ocr` | Vision (OCR) | Native addon | ✅ | ❌ |
| `darwinkit` | Vision + NaturalLanguage | Subprocess / JSON-RPC | ✅ | ✅ (binary) |
| `eventkit-node` | EventKit | Native addon | ✅ | ❌ |
| `node-mac-contacts` | Contacts (CNContactStore) | Native addon | ✅ | ❌ |
| `@appkit/apple-contacts` | Contacts (SQLite) | Pure TypeScript | ✅ | ✅ |
| `node-mac-auth` | LocalAuthentication | Native addon | ✅ | ❌ |
| `@nativescript/macos-node-api` | **All macOS APIs** | Runtime + TS types | ✅ | ❌ |
| `node-swift` | Any Swift API | Swift → Node module | ✅ | ❌ |
| `ffi-napi` | Any C-level API | FFI | ✅ | ❌ |
| `react-native-vision` | VisionKit + CoreML | React Native | ⚠️ Alpha | ❌ |
| `react-native-visionos` | visionOS SDK | React Native | ✅ | ❌ |
| `NodObjC` | All ObjC APIs | Dynamic bridge | ❌ Unmaintained | ❌ |

### Decision Guide

| Goal | Use |
|---|---|
| OCR / text recognition from images | `@cherrystudio/mac-system-ocr` |
| NLP (sentiment, language detection, NER, embeddings) | `darwinkit` |
| Vision + NLP without native build | `darwinkit` (subprocess) |
| Calendar / Reminders | `eventkit-node` |
| Read+write Contacts | `node-mac-contacts` |
| Read-only Contacts, no native build | `@appkit/apple-contacts` |
| Touch ID / biometric auth | `node-mac-auth` |
| Access **any** Apple framework in TypeScript | `@nativescript/macos-node-api` |
| Use Swift-only APIs (WidgetKit, SwiftData, etc.) | `node-swift` |
| React Native iOS ML / Vision | `react-native-vision` |
| Build native visionOS app in React | `react-native-visionos` |
