---
paths:
  - "src/macos/GenesisTools/Package.swift"
  - "src/macos/GenesisTools/Sources/GenesisTools/**"
  - "src/macos/GenesisTools/Sources/Host/**"
  - "src/macos/GenesisTools/Sources/Parts/*/HostImport.swift"
  - "src/macos/GenesisTools/Sources/Parts/*/*Entry.swift"
  - "src/macos/GenesisTools/Sources/Parts/*/*Plugin.swift"
  - "src/macos/GenesisTools/Sources/Parts/*/Settings/*Plugin.swift"
  - "src/macos/lib/permissions/parts.ts"
  - "scripts/native/app-faces.ts"
---

# GenesisTools.app: the host, its optional parts and their settings plug-ins

Covers how the app splits into a host and parts, how a part registers faces and settings pages, and what a new or moved part touches.

The app is a host plus optional parts (Martin, 2026-10-18). `Sources/Host/` (library `GenesisToolsHost`) is the
launcher, `--rpc`, the permission faces, vault approval, notifications, the microphone, the link router, the
permissions window, and the launchers that start another part's face (`FeatureSettingsLaunch`, `WidgetLaunch`). Each
part is one library under `Sources/Parts/`: `Features/` (the feature settings window, `--features`), `Hub/` (hub and
review), `Widget/`, `Clicky/`, `Markdown/`, `Meetings/`, `Recorder/`. `Sources/GenesisTools/` is the executable: it registers the parts its build
links (`Parts.swift`) and calls `runHost()`.

- 🛑 A part never imports another part (Martin, 2026-10-18: "GenesisToolsClicky doesn't need hub, and hub doens't need
  clicky"). Package.swift gives each part target only the host and the kit, so the compiler refuses such an import.
  A part reaches another part in two ways only: it starts that part's face in a new process through a host launcher,
  or it adds pages to the feature settings window.
- **Settings pages are plug-ins.** A part with pages implements GenesisKit's `FeatureSettingsPlugin`
  (Settings/FeatureSettingsPlugin.swift): `install(in:)` registers its sections and, in `.live` mode, starts its
  services in the window's process (Clicky's status item, the widget's dictation and Focus runtime). The executable adds
  each linked part's plug-in (`registerSettingsPlugins` in Parts.swift). The window's own pages are General,
  Background (the daemon) and About. `--clicky` is the face's old name and still works.

- `GENESIS_APP_PARTS` picks the parts (Package.swift); unset is every part, so a plain `swift build` and `swift test`
  see the whole app. `src/macos/lib/permissions/parts.ts` is the TypeScript table; a build makes the installed parts
  (the host alone on a fresh install), and `tools hub` adds the hub. Each parts set has its own `.build/opt-<ids>`.
- The host starts a part's face only through `AppParts` (Host/AppParts.swift); a face whose part is not linked prints
  the `tools macos permissions build --add-part <id>` command and exits 69. Never call a part's `run…` from the host.
- A host symbol a part uses is `package`; a part's `run…` entry point and plug-in are `package` for the executable.
  Everything else stays internal: mark `package` only what another module uses, which the build names when it is
  missing. The tests use `@testable import`, so they need no mark.
- A new part: one target in Package.swift, one block in `Sources/GenesisTools/Parts.swift`, one row in parts.ts. A part
  with settings pages adds its plug-in in Parts.swift and `requires: ["features"]` in both tables (a build makes the
  window with it; `requires` never adds a code link).
- A new face is one entry in its part's `faces` in parts.ts (`AppFace`: `flag`, `aliases`, `window`, `reopen`, `quit`)
  and its run closure in the part's `AppParts.register` line. The host never lists faces by hand: `AppParts.partOfFace`,
  `FaceRecord.isWindowFace`, `PartQuit.faceNames` and `faceOrder` read `AppFaces.declared`, which
  `bun scripts/native/app-faces.ts --write` (and every build) writes into `Sources/Host/AppFaces+Declared.swift`, and
  the rebuild's `windowFaceKind` reads the same entry. permissions.test.ts fails when that file, the declarations and the
  Parts.swift registrations drift apart. Staging (`NativeStaging`) and `LinkRelay.mayRunAgain` still name their few
  faces in code: a new face touches them only to ship behind staging or to run itself again behind a fresh relay.
- Moving a part to another repository: its folder, its plug-in line in Parts.swift and its row in both tables. What it
  uses from the host and the kit must then be `public`, because `package` access stops at the package border.
