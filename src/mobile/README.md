# tools mobile

Builds, installs and drives a project's mobile app on an iOS simulator. It knows the Xcode 27 rules: DeviceHub.app
replaced Simulator.app, so Expo's `run:ios` fails, and an Appium XCUITest driver older than 12.13 reboots the
simulator. The tool knows no app by itself: the project describes its app in a `mobile.config.ts`.

```bash
tools mobile doctor                 # Xcode, DeviceHub, the XCUITest driver, Appium, booted simulators
tools mobile config                 # the project config this folder resolves to
tools mobile routes                 # the project's screens and their deep links
tools mobile build --udid <udid> --configuration Release --derived-data <dir>
```

Without `--udid` a command uses the only booted simulator and refuses when several are booted, so it never drives
another session's. Nothing here opens a simulator UI: an open DeviceHub changes `isHeadless` for every Appium session
on the Mac.

## The project config

Every command that works on an app reads `--config <file>`, or else the nearest `mobile.config.ts` or
`e2e/mobile.config.ts` at or above the working folder. The file default-exports a `MobileProjectConfig`
(`@genesiscz/utils/mobile/project`); paths in it are relative to the file.

```ts
import type { MobileProjectConfig } from "@genesiscz/utils/mobile/project";

export default {
    id: "shop",
    appDir: "..",
    routes: [{ name: "home", url: "shop:///", rootId: "screen-home" }],
    platforms: {
        ios: {
            bundleId: "com.example.shop",
            build: { workspace: "ios/Shop.xcworkspace", scheme: "Shop", configuration: "Release", productName: "Shop" },
            buildInputs: { native: ["ios/Podfile.lock", "app.json"], js: ["src/**/*.{ts,tsx}"] },
        },
    },
} satisfies MobileProjectConfig;
```

- `id` names the build log, the install records and the run folders.
- `routes` is a list, or a function of the app folder that reads the screens from the app's own tree.
- `platforms` holds one entry per platform. `bundleId` may be a function of the app folder (an Expo app reads its
  `app.json`).
- `buildInputs` decides when a build is stale: `native` globs go into every build, `js` globs only into a Release
  build. Without it a build counts as current until `--build always`.

## build

`xcodebuild -workspace … -scheme … -sdk iphonesimulator -destination id=<udid>`, with the whole output in
`~/.genesis-tools/mobile/builds/xcodebuild-<id>-<configuration>.log`, then `simctl install`. A build writes
`gt-fingerprint-<configuration>.json` into its DerivedData (the size and modification time of every build input). Give
each session its own `--derived-data`.

The generic pieces are in `@genesiscz/utils/mobile/`: `project` (the config contract and loader), `simulator` (simctl,
device types and screens, privacy, user defaults, WDA ports), `appium` (the driver check, the per-simulator port) and
`webdriver` (a minimal W3C client over `fetch`).

## Ports and owned servers, one set per simulator

Each simulator gets its own ports from an FNV-1a hash of its udid (`udidSlot` in `@genesiscz/utils/mobile/simulator`):
WebDriverAgent 18100 to 18999 (MJPEG 1000 above), Appium 4900 to 4999. XCUITest kills every WDA on its port that
belongs to another simulator, so a shared port makes two agents kill each other's sessions.

```bash
tools mobile appium start|stop|status --udid <udid>
tools mobile metro status|stop <port>
```

`appium start` runs this tool's own server on the simulator's port from `/tmp`, with its pidfile and log in
`~/.genesis-tools/mobile/appium/<port>.{pid,log}`, and refuses an XCUITest driver that predates DeviceHub. `stop` stops
only a server this tool started (the pidfile records the process start time, so a reused pid is never signalled).
Metro (`bunx expo start` from the app folder, `CI` removed so it rebuilds) keeps the same record in
`~/.genesis-tools/mobile/metro/<port>.{pid,log}`.

More shared pieces: `service` (a detached server with a pidfile), `wda` (WebDriverAgent's session-less routes, so a
second actor can read the screen while a run holds the only Appium session), `alerts` (a rule table that answers known
system alerts for the app under test through WDA or idb and leaves every other alert alone), `idb` and `a11y` (the
XCUITest tree parser, the readable tree, the LogBox reader).
