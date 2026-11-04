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

## up

```bash
tools mobile up --name gt-mine --metro-port 8091 --derived-data /tmp/cc/<you>/build
```

`up` takes `--udid`, or the simulator named `--name` (default `gt-w<width>`), and creates it when missing: the iPhone
type whose screen is `--width` points wide (default `platforms.ios.defaultWidth`; read from each device type's
`capabilities.plist`, or `profile.plist` before Xcode 27), the newest iOS runtime that runs it (`--os` pins one). It
boots it with `simctl bootstatus -b`. It only ever picks a simulator by its exact name or udid.

- **Build when stale** (`--build auto`, the default; `always` and `never` force it), from the fingerprint above.
- **Install** when it built, when the app is missing, or when the installed build is not the one in DerivedData (a
  record per simulator and project in `~/.genesis-tools/mobile/installs/`).
- **First run**: the grants in `platforms.ios.firstRun` (below).
- **Metro** (Debug, the default when the project sets `metro`; `--release` skips it), pointed at by the
  `RCT_jsLocation` user default, which React Native's bundle URL provider reads before its built-in 8081.
- **Launch**, answer the system alerts the launch raises, and wait (`--launch-timeout`) until Metro's log shows the
  app fetched its bundle. Fatal Metro lines after the launch (a failed bundle, an uncaught error) fail the command.

## open, capture, tour: the screen drivers

```bash
tools mobile open agents --udid <udid>               # a route name, name?query, or a URL
tools mobile capture order?id=a1 --udid <udid>
tools mobile tour --udid <udid> --only home order
```

All three go through one table (`src/mobile/lib/screen-driver.ts`):

- `appium` (the default) opens a link with `mobile: deepLink`, so iOS shows no "Open in <app>?" alert, and waits up to
  15 s for the screen's root element (its `rootId`). The session attaches to the installed app (`noReset`,
  `shouldTerminateApp: false`), so closing it leaves the app on screen.
- `simctl` needs no Appium session: `simctl openurl`, then the alert watcher answers "Open in" for the app.

`capture` saves `<name>.png`, the raw tree `<name>.xml`, `<name>.tree.txt` (one line per element with a testID, words or
a tap target, anonymous containers folded) and `<name>.json` (testIDs, visible words, tap targets, open alerts,
whether a LogBox shows) into `~/.genesis-tools/mobile/captures/<id>/<time>/` (or `--out`). `tour` saves
`<NN>-<route>.png` per route into `~/.genesis-tools/mobile/tours/<id>/<time>/`; a root that never shows is saved as
`<NN>-<route>.MISSING.png` and the run exits 1.

## alerts, logbox, first-run

- `alerts [--watch]` answers the known system alerts for the app (Open in, notifications, local network, location,
  tracking, access asks, Save Password) through WDA's session-less routes when WDA runs, else `idb ui describe-all`.
  An alert of another app, and any alert no rule knows (the app's own `Alert.alert`), is left alone. An idb tap
  re-reads the label under the point first, so it never lands on the app behind an alert someone else answered.
- `logbox [--clear minimize|dismiss]` reads every entry of React Native's LogBox (Debug builds) from the tree, then
  minimizes or dismisses it, and reads the project's Metro log from the newest bundle on. Exit 1 when either has one.
- `first-run [--keep-install] [--reset-keychain]` reinstalls the build (an uninstall keeps an app's keychain items, so
  `--reset-keychain` empties the simulator's keychain too), grants `firstRun.privacy` with `simctl privacy`, runs
  `idb approve` for `firstRun.idbApprove` and the `firstRun.scheme` URL where idb is installed, writes
  `firstRun.defaults`, then launches and answers the first prompts. A `simctl privacy` grant that times out leaves a
  marker (`~/.genesis-tools/mobile/privacy-hangs/<udid>`): on some iOS 26.5 simulators one grant wedges installd, and
  later runs skip grants there.

## Devices on every platform

```bash
tools mobile devices [--platform ios|android]
tools mobile boot <udid | AVD name> [--platform android]
tools mobile install [artifact] --device <udid | serial>
tools mobile launch | terminate | uninstall --device <id>
tools mobile url <route | URL> --device <id>
tools mobile screenshot <file.png> --device <id>
tools mobile shutdown --device <id>
```

These commands go through one table (`PLATFORMS` in `src/mobile/lib/platforms/`), one `MobilePlatform` per
platform: `ios` (simulators through simctl) and `android` (emulators and devices through adb, AVDs through the SDK's
`emulator`). A project names its Android app beside its iOS one:

```ts
platforms: {
    android: { packageName: "com.example.shop", activity: ".MainActivity", apk: "android/app/build/outputs/apk/debug/app-debug.apk" },
}
```

`--platform` defaults to the project's only platform. `--device` defaults to the only booted device of that platform,
so a command never drives another session's. Android:

- `devices` lists what adb sees (an emulator under its AVD name) and every AVD that does not run as `avd:<name>`.
- `boot <AVD>` starts the emulator as a server this tool owns (`-no-snapshot-save -no-boot-anim -gpu host -noaudio`, on
  the first free console port, log and pidfile in `~/.genesis-tools/mobile/emulator/<avd>.{log,pid}`) and waits until
  adb answers and `sys.boot_completed` is 1. An emulator that stays `offline` has USB debugging off in the guest; boot
  reports it instead of waiting.
- `launch` starts `activity`, else the package's launcher activity; `url` sends a VIEW intent to the package.
- The Android SDK root is `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`.

`build`, `up`, `open`, `capture`, `tour`, `alerts`, `logbox` and `first-run` are iOS only for now: they rest on
xcodebuild, the XCUITest tree and WebDriverAgent.
