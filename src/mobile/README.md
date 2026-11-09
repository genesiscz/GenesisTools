# tools mobile

Builds, installs and drives a project's mobile app: iOS simulators for building, opening and capturing screens, a
signed device archive for TestFlight, and Android emulators and devices for the basic device commands. It is for a
developer or an agent who needs the app on a simulator, a screenshot of every screen, or a TestFlight build, without
Xcode's UI.

It knows the Xcode 27 rules. DeviceHub.app replaced Simulator.app, so Expo's `run:ios` fails ("Can't determine id of
Simulator app"), and an Appium XCUITest driver older than 12.13 shuts the simulator down and then fails. The tool
knows no app by itself: the project describes its app in a `mobile.config.ts` (see [Configuration](#configuration)).

## Quick start

```bash
tools mobile doctor                 # check Xcode, DeviceHub, the XCUITest driver, Appium and booted simulators
tools mobile routes                 # the screens your mobile.config.ts names, with the deep link of each
tools mobile up --width 390         # find or create a 390-point iPhone, boot it, build when stale, install, launch
tools mobile capture home           # screenshot and accessibility tree of the "home" screen
tools mobile tour                   # one screenshot per screen
tools mobile release --dry-run      # the TestFlight steps, and what is still missing
```

Without `--udid` (or `--device`), a command uses the only booted simulator and refuses when several are booted, so it
never drives another session's. `up` picks its simulator by name instead. Nothing here opens a simulator UI: an open
DeviceHub changes `isHeadless` for every Appium session on the Mac.

## Commands

Every command that works on an app takes `--config <file>`. Without it, the tool uses the nearest `mobile.config.ts`
or `e2e/mobile.config.ts` at or above the working folder. Every command also takes `-v, --verbose`.

### Check and inspect

```bash
tools mobile doctor [--appium-port 4723] [--json]
tools mobile config [--json]
tools mobile routes [--json]
```

- `doctor` reads the state and changes nothing. It checks the Xcode developer folder, the simulator UI this Xcode
  ships (Simulator.app or DeviceHub.app, and whether it is open), the XCUITest driver under the Appium home, Appium
  on `--appium-port` (default 4723), adb and the Android emulator, and the booted simulators with each one's WDA
  port. A failed check prints its fix where there is one. `doctor` exits 1 when a check fails, which includes no
  booted simulator.
- `config` prints the config file, the project id and title, the app folder, the platforms and the number of screens.
- `routes` lists the screens in order with their deep links.

### Build and bring up (iOS)

```bash
tools mobile build \
    --udid <udid> \
    --configuration Release \
    --derived-data ~/Projects/app/.builds/a
tools mobile up \
    --name gt-mine \
    --metro-port 8091 \
    --derived-data ~/Projects/app/.builds/a
```

`build` runs `xcodebuild` for one simulator, then `simctl install`.

| Flag | What it does (default) |
|---|---|
| `--udid <udid>` | the simulator (the only booted one) |
| `--no-install` | build only; with `--udid`, the simulator need not be booted |
| `--derived-data <dir>` | the DerivedData folder (`<app>/ios/build`); give each session its own |
| `--configuration <name>` | `Debug` (JS from Metro) or `Release` (JS in the app); default: the project's |

`up` brings the app up on a simulator sized for a phone width, in this order:

1. **Simulator.** It takes `--udid`, or the simulator named `--name` (default `gt-w<width>`), and creates it when it is
   missing. It only ever picks a simulator by its exact name or udid. A new simulator gets the iPhone type whose
   screen is `--width` points wide, within one point (the exact width first, then the sharper screen, then the newest
   model). The width comes from each device type's `capabilities.plist`, or `profile.plist` before Xcode 27. The
   runtime is the newest iOS that runs that type; `--os` pins a version or a prefix (`26.5`, `27`). It boots the
   simulator with `simctl bootstatus -b`.
2. **Build when stale** (`--build auto`), from the build fingerprint (see [How it works](#how-it-works)). `always`
   builds every time; `never` refuses when there is no build.
3. **Install** when it built, when the app is missing, or when the installed build is not the one in DerivedData. It
   keeps a record per simulator and project in `~/.genesis-tools/mobile/installs/<udid>-<id>.json`.
4. **First run**: the grants and defaults in `platforms.ios.firstRun` (see `first-run` below).
5. **Metro**, for a Debug build only. `up` builds Debug when the project sets `metro`, and Release with `--release` or
   when the project has no `metro`. It points the app at Metro's port with the `RCT_jsLocation` user default, which
   React Native's bundle URL provider reads before its built-in 8081. `up` always starts a new Metro: a port that
   already answers is an error, also when an earlier `up` started that Metro. Run `tools mobile metro stop <port>`
   before the next `up`, or pass another `--metro-port`.
6. **Launch**, answer the system alerts the launch raises, and wait (`--launch-timeout`) until Metro's log shows that
   the app fetched its bundle. A fatal Metro line after the launch (a failed bundle, an uncaught error) fails the
   command. At the end it prints the simulator's Appium and WDA ports and the next commands.

| Flag | What it does (default) |
|---|---|
| `--udid <udid>` | use this simulator instead of finding one by name |
| `--name <name>` | the simulator's name; created when missing (`gt-w<width>`) |
| `--width <points>` | the phone width in points (`platforms.ios.defaultWidth`) |
| `--os <version>` | the iOS runtime for a new simulator (the newest) |
| `--release` | run the Release build: JavaScript inside the app, no Metro |
| `--derived-data <dir>` | the DerivedData folder (`<app>/ios/build`) |
| `--build <when>` | `auto`, `always` or `never` (`auto`) |
| `--metro-port <port>` | the Metro port for a Debug build (`metro.defaultPort`) |
| `--launch-timeout <s>` | how long to wait for the app to fetch its bundle (180) |
| `--json` | print the report as JSON |

### Screens (iOS)

```bash
tools mobile open order --udid <udid>               # a route name
tools mobile open "order?id=a1" --udid <udid>       # a route name with a query
tools mobile open shop://cart --udid <udid>         # a whole URL
tools mobile capture order --udid <udid>
tools mobile tour --udid <udid> --only home order
```

- `open <route>` opens one screen by its deep link and waits for the screen's root element.
- `capture [route]` opens the route (or keeps the current screen) and saves `<name>.png`, the raw tree `<name>.xml`,
  `<name>.tree.txt` (one line per element with a testID, words or a tap target, anonymous containers folded) and
  `<name>.json` (testIDs, visible words, tap targets, open alerts, whether a LogBox shows). The folder is
  `~/.genesis-tools/mobile/captures/<id>/<time>/`, or `--out`. `--name` sets the file stem (the route name, or
  `screen`).
- `tour` opens every route in order (or the `--only` ones) and saves `<NN>-<route>.png` into
  `~/.genesis-tools/mobile/tours/<id>/<time>/`, or `--out`. A root that never shows is saved as
  `<NN>-<route>.MISSING.png`, the tour goes on, and the run exits 1.

A route is a route name (`agents`), a route name with a query (`order?id=a1`, which keeps the route's root id), or a
whole URL (`shop://cart`, opened with no root to wait for). An unknown route fails before a device session starts.
The app must be installed; the command says so when it is not.

| Flag | What it does (default) |
|---|---|
| `--udid <udid>` | the simulator (the only booted one) |
| `--driver [driver]` | `appium` or `simctl` (`appium`) |
| `--appium-port <port>` | the Appium server (the simulator's own, started when missing) |
| `--settle <ms>` | the pause after the root shows (1500; 2500 for `tour`) |
| `--out <dir>` | `capture` and `tour`: the output folder |
| `--name <name>` | `capture`: the file name stem |
| `--only <names...>` | `tour`: only these route names |
| `--json` | print the result as JSON |

The two drivers come from one table (`@genesiscz/utils/mobile/screen-driver`):

- `appium` opens a link with `mobile: deepLink`, so iOS shows no "Open in <app>?" alert, and waits up to 15 s for the
  route's `rootId`. The session attaches to the installed app (`noReset`, `shouldTerminateApp: false`), so closing it
  leaves the app on screen. Permission prompts and app confirmations stay open for the capture to show.
- `simctl` needs no Appium session: it launches the app, runs `simctl openurl`, and the alert watcher answers "Open
  in" for the app through idb or a WDA another run started. It reads the tree only while WDA runs, so a capture with
  no WDA saves the PNG and the JSON only.

### App state (iOS)

```bash
tools mobile alerts --udid <udid> [--watch]
tools mobile logbox --udid <udid> [--clear dismiss]
tools mobile first-run --udid <udid> [--keep-install] [--reset-keychain]
```

- `alerts` looks for the known system alerts of the app for `--timeout` seconds (5) and answers them, or keeps
  answering until Ctrl-C with `--watch`. It reads them through WDA's session-less routes when WDA runs, else through
  `idb ui describe-all`; `--backend wda|idb` forces one. The rules: "Open in" (Open for this app, Cancel for another
  build of the same scheme), notifications, local network, location (Allow While Using App), tracking (Ask App Not to
  Track), access asks (camera, microphone, photos, contacts, calendars, Face ID) and Save Password (Not Now). An
  alert no rule knows (the app's own `Alert.alert`) is left alone. A permission alert of another app is left alone
  too. "Open in" for another app gets Cancel, and Save Password gets Not Now for any app. An idb tap re-reads the
  label under the point first, so it never lands on the app behind an alert someone else answered.
- `logbox` reads every entry of React Native's LogBox (Debug builds) from the tree, then minimizes it
  (`--clear minimize`, the default) or dismisses it (`--clear dismiss`). A dismiss removes one entry and shows the
  next, so `--clear dismiss` taps Dismiss once per entry (up to 40) until the LogBox closes. Minimize needs one tap,
  so it is the default. It also reads the Metro log of `--metro-port` (default `metro.defaultPort`) from the newest
  bundle on. It exits 1 when a LogBox showed or Metro has a fatal line. `--appium-port` picks the Appium server.
- `first-run` puts the app into its fresh-install state:
  1. It checks that the `.app` is a real build with the project's bundle id, uninstalls the app when it is there,
     and installs the `.app` again. The `.app` is `--app-path`, or the `--configuration` build (`Release`) in
     `--derived-data` (`<app>/ios/build`). `--keep-install` skips this step.
  2. An uninstall keeps an app's keychain items, so a saved login survives it. `--reset-keychain` empties the
     simulator's whole keychain as well.
  3. It grants `firstRun.privacy` with `simctl privacy`, runs `idb approve` for `firstRun.idbApprove` and the
     `firstRun.scheme` URL where idb is installed, and writes `firstRun.defaults`.
  4. It launches the app and answers the first prompts for `--answer` seconds (15).

### Background servers

```bash
tools mobile appium start --udid <udid>     # also: --port <port>
tools mobile appium status --udid <udid> [--json]
tools mobile appium stop --udid <udid>
tools mobile metro status 8091 [--json]
tools mobile metro stop 8091
```

- `appium start` starts this tool's own Appium server on the simulator's port (4900 to 4999, see
  [How it works](#how-it-works)) unless a server already answers there. Before it starts one, it refuses an
  XCUITest driver that predates DeviceHub. It also refuses when no XCUITest driver is installed under the Appium home
  (`appium driver install xcuitest@12.22.8`). `logbox`, and `open`, `capture` and `tour` with the `appium` driver,
  start Appium the same way, so they refuse in the same cases. It uses `appium` from PATH, else `bunx --yes appium`,
  and runs it from the system temp folder (`$TMPDIR`): from a repository with a hoisted `node_modules`, Appium
  resolves its own dependencies from there and breaks.
- `appium status` says whether Appium answers on the port, its version, and whether this tool started it. It exits 1
  when nothing answers.
- `appium stop` and `metro stop` stop only a server this tool started. A server another process owns keeps running.
- `metro status <port>` says whether Metro answers and prints the fatal lines since its newest bundle. It exits 0
  either way. Metro itself is started by `up`.

### Devices on every platform

```bash
tools mobile devices [--platform ios|android]
tools mobile boot <udid | AVD name> [--platform android] [--timeout 300]
tools mobile install [artifact] --device <udid | serial>
tools mobile launch --device <id>
tools mobile terminate --device <id>
tools mobile uninstall --device <id>
tools mobile url <route | URL> --device <id>
tools mobile screenshot shots/home.png --device <id> [--json]
tools mobile shutdown --device <id>
```

These go through one table (`PLATFORMS` in `src/mobile/lib/platforms/`), one `MobilePlatform` per platform: `ios`
(simulators through simctl; simctl cannot reach a physical iPhone) and `android` (emulators and devices through adb,
AVDs through the SDK's `emulator`).

- `--platform` defaults to the project's only platform. A project with two platforms, or no project, needs it.
- `--device` takes a udid, an adb serial or a device name, and defaults to the only booted device of that platform.
  The device must be booted.
- `devices` lists every platform, or one with `--platform`, and needs no project. A platform whose tools are missing
  prints a warning instead of failing the list.
- `boot <device>` boots a simulator by its udid (`simctl bootstatus -b`), or an Android AVD by its name, and waits up
  to `--timeout` seconds (300).
- `install [artifact]` installs a `.app` or an `.apk`. Without a path it installs the project's build: on iOS the
  build of `build.configuration` in `<app>/ios/build`, on Android `platforms.android.apk`. A build in another
  `--derived-data` folder needs its path.
- `launch` refuses when the app is not installed. `url` opens a route name or a URL with the platform's own link
  handling, with no Appium. `screenshot` saves a PNG and creates its folder.
- On iOS, `url` is a plain `simctl openurl`, and it leaves the "Open in <app>?" alert open. Answer it with
  `tools mobile alerts`, set `firstRun.scheme` so that `up` and `first-run` pre-approve the scheme through idb, or use
  `tools mobile open`, which raises no alert.
- `install`, `uninstall`, `launch`, `terminate` and `url` need a project config. `devices`, `boot`, `shutdown` and
  `screenshot` do not, but without a config every one except `devices` needs `--platform`.

Android specifics:

- `devices` lists what adb sees (an emulator under its AVD name) and every AVD that does not run, as `avd:<name>`.
- `boot <AVD>` starts the emulator as a server this tool owns, with
  `-no-snapshot-save -no-boot-anim -gpu host -noaudio`, on the first even console port from 5554 to 5682 that adb does
  not list. Its log and pidfile are in
  `~/.genesis-tools/mobile/emulator/<avd>.{log,pid}`. It waits until adb answers and `sys.boot_completed` is 1.
- `-gpu host` draws on the Mac's GPU through Metal. An AVD's own lavapipe or SwiftShader mode draws on the CPU and,
  under memory pressure, starved QEMU into "hanging thread" crashes. `-noaudio` saves the idle cost of the audio
  threads. `-no-snapshot-save` makes every boot clean.
- `launch` starts `activity`, else the package's launcher activity. `url` sends a VIEW intent to the package; an
  `http` or `https` URL goes without the package, so the system picks the handler.
- `shutdown` stops an emulator (`adb emu kill`, then the owned process) and refuses a physical device.

`build`, `up`, `open`, `capture`, `tour`, `alerts`, `logbox` and `first-run` are iOS only for now: they rest on
xcodebuild, the XCUITest tree and WebDriverAgent.

### Release to TestFlight (iOS)

```bash
tools mobile release --dry-run
tools mobile release \
    --team <team id> \
    --api-key AuthKey_ABC123.p8 \
    --api-key-id <key id> \
    --api-issuer <issuer id>
```

| Flag | What it does (default) |
|---|---|
| `--team <id>` | the Apple Developer team id (developer.apple.com > Membership details) |
| `--api-key <file>` | the App Store Connect API key, `AuthKey_XXXX.p8` |
| `--api-key-id <id>` | the API key id |
| `--api-issuer <id>` | the issuer id, shown above the key list |
| `--build-number <n>` | `CFBundleVersion` (the UTC clock to the minute, `202611091405`) |
| `--export-only` | export the `.ipa` and do not upload |
| `--dry-run` | print every step and what is missing; build nothing |
| `--json` | print the plan as JSON (with `--dry-run`) |

The key comes from App Store Connect > Users and Access > Integrations > Keys. The steps, in order:

1. The project's own preparation, `platforms.ios.release.prepare` (for example `expo prebuild`), given the build
   number.
2. `pod install` in `ios/`. `release.pods: true` always runs it, `false` never does, and without the key it runs when
   `ios/Podfile` exists after the preparation.
3. A signed device archive: `xcodebuild archive`, Release, `generic/platform=iOS`, automatic signing,
   `-allowProvisioningUpdates`, the project's `buildSettings`, `DEVELOPMENT_TEAM` (the team), and
   `CURRENT_PROJECT_VERSION` and `INFOPLIST_KEY_CFBundleVersion` (the build number).
4. An export with `ExportOptions.plist` (method `app-store-connect`, automatic signing, symbols uploaded) that uploads
   to App Store Connect, or keeps the `.ipa` with `--export-only`. TestFlight shows the build after processing.

Each upload needs a higher build number than the last one; the clock default gives that. A run refuses while one of
the four account flags is missing, `--export-only` included, and `--dry-run` exits 1 for the same reason. A missing
`--api-key` file is an error before anything runs. Each step runs for up to one hour, and the run stops at the first
failure with its log path.

## How it works

### Where data lives

Everything is under `~/.genesis-tools/mobile/` (the root moves with `GENESIS_TOOLS_HOME`). `<id>` is the project id,
and `<time>` is a local time stamp such as `2026-11-04T21-05-33`.

| Path | What it holds |
|---|---|
| `builds/xcodebuild-<id>-<configuration>.log` | the whole xcodebuild output of the last build |
| `installs/<udid>-<id>.json` | which build `up` installed on a simulator |
| `appium/<port>.{pid,log}` | an Appium server this tool started |
| `metro/<port>.{pid,log}` | a Metro this tool started |
| `emulator/<avd>.{pid,log}` | an Android emulator this tool started |
| `captures/<id>/<time>/` | `capture` output |
| `tours/<id>/<time>/` | `tour` output |
| `privacy-hangs/<udid>` | a marker: a privacy grant hung on this simulator |
| `releases/<id>/<time>/` | `ExportOptions.plist`, `<productName>.xcarchive`, `export/`, one `<NN>.log` per step |

A build also writes `gt-fingerprint-<configuration>.json` into its DerivedData folder.

### Builds and staleness

`build` and `up` run `xcodebuild` with `-workspace`, `-scheme`, `-configuration`, `-sdk iphonesimulator`,
`-destination id=<udid>`, `-derivedDataPath` and the project's `buildSettings`, bounded at one hour. A failed build
raises its last five `error:` lines and the log path. The `.app` is
`Build/Products/<configuration>-iphonesimulator/<productName>.app` under DerivedData.

The fingerprint holds the size and modification time of every build input, taken before the build starts, so a file
saved while xcodebuild runs makes the next `up` build again. `buildInputs.native` globs go into every build; `js`
globs only into a Release build, because a Debug build loads its JavaScript from Metro. A build is stale when it is
missing, has no fingerprint (another tool built it), or an input changed, appeared or went. Without `buildInputs`, a
build counts as current until `--build always`. Give each session its own `--derived-data`, so two builds never
share one.

### Ports and owned servers, one set per simulator

Each simulator gets its own ports from an FNV-1a hash of its udid (`udidSlot` in `@genesiscz/utils/mobile/simulator`):
WebDriverAgent 18100 to 18999 (MJPEG 1000 above), Appium 4900 to 4999. XCUITest kills every WDA on its port that
belongs to another simulator, so a shared port makes two agents kill each other's sessions. The Appium session sets
`isHeadless` to match whether a simulator UI is open; a wrong value reboots the simulator on Xcode 27.

Appium, Metro and the Android emulator run detached, each with a log and a pidfile. The pidfile records the process
start time, so a stop never signals a pid the OS has since given to another program. These servers keep running after
the command ends. `open`, `capture`, `tour` and `logbox` close only their Appium session and leave Appium up. `up`
leaves Metro up, and `boot` leaves the emulator up. Stop them with `tools mobile appium stop --udid <udid>`,
`tools mobile metro stop <port>` and `tools mobile shutdown --device <id>`.

Metro is `bunx expo start --port <port>`, run from the app folder (from a repository root it cannot resolve the app's
modules). The tool removes `CI` from its environment, because Metro with `CI` set serves the bundle it started with
and never rebuilds, and agent shells export `CI=1`. It also sets `EXPO_NO_TELEMETRY=1` and `BROWSER=none`. The tool
probes Metro on 127.0.0.1, because localhost can resolve to ::1 while Metro binds IPv4. It never reuses a Metro,
because it cannot verify which project a running Metro serves: a port that already answers is an error, also when
an earlier `up` started that Metro.

### First-run grants

`simctl privacy` grants only some services (`calendar`, `contacts-limited`, `contacts`, `location`,
`location-always`, `photos-add`, `photos`, `media-library`, `microphone`, `motion`, `reminders`, `siri`). iOS has no
simctl service for notifications, the camera or the local network: those need `idb approve`
(`brew install idb-companion`). Each grant is bounded at 8 s. On some iOS 26.5 simulators one grant wedges installd
until a reboot, and the hang comes back after the reboot. A grant that times out leaves the marker
`~/.genesis-tools/mobile/privacy-hangs/<udid>`, and later runs skip grants on that simulator. Every grant, approval
and user default is best-effort: what failed is in the report, never a thrown error. The reinstall check of
`first-run` is an error: a replacement `.app` that is missing or has another bundle id stops the command.

### What it needs on the Mac

- Xcode with the iOS simulator runtimes, selected with `xcode-select`.
- Appium with the XCUITest driver for the `appium` screen driver and `logbox`. On Xcode 27 the driver must be 12.13.0
  or newer; 12.22.8 is the newest for Appium 3, and driver 13 needs Appium 4.
- idb (`brew install idb-companion`), optional: it answers alerts while no WDA runs, and gives the idb approvals.
- Bun for Metro (`bunx expo start`), and CocoaPods (`pod`) for a release whose app has an `ios/Podfile`.
- The Android SDK (adb and `emulator`), only for Android.
- For `release`: an Apple Developer Program team and an App Store Connect API key.

Nothing here calls a paid API. `release` needs a paid Apple Developer Program membership.

## Configuration

### The project config

The file default-exports a `MobileProjectConfig` (`@genesiscz/utils/mobile/project`). `appDir` is relative to the
config file. Every other path (`build.workspace`, the `buildInputs` globs, `android.apk`, the `release.prepare` `cwd`)
is relative to the app folder. A relative `--config` resolves from the working folder. A file with a wrong shape
fails with every problem and the file name.

```ts
import type { MobileProjectConfig } from "@genesiscz/utils/mobile/project";

export default {
    id: "shop",
    title: "Shop",
    appDir: "..",
    metro: { defaultPort: 8091 },
    routes: [
        { name: "home", url: "shop:///", rootId: "screen-home" },
        { name: "order", url: "shop:///order", rootId: "screen-order" },
    ],
    platforms: {
        ios: {
            bundleId: "com.example.shop",
            build: { workspace: "ios/Shop.xcworkspace", scheme: "Shop", configuration: "Release", productName: "Shop" },
            buildInputs: { native: ["ios/Podfile.lock", "app.json"], js: ["src/**/*.{ts,tsx}"] },
            defaultWidth: 390,
            firstRun: {
                privacy: ["location", "photos"],
                idbApprove: ["camera", "notification"],
                scheme: "shop",
                defaults: [{ key: "ShowDevMenuAtLaunch", value: ["-bool", "NO"] }],
            },
            release: {
                prepare: ({ buildNumber }) => [
                    {
                        title: "native project",
                        command: ["bunx", "expo", "prebuild", "--platform", "ios", "--no-install"],
                        env: { BUILD_NUMBER: buildNumber },
                    },
                ],
            },
        },
        android: {
            packageName: "com.example.shop",
            activity: ".MainActivity",
            apk: "android/app/build/outputs/apk/debug/app-debug.apk",
        },
    },
} satisfies MobileProjectConfig;
```

- `id` (required): letters, digits, dot, dash or underscore. It names the build log, the install records and the run
  folders.
- `title`: the display name; default the id.
- `appDir`: the app folder (the one holding `ios/`); default the config file's folder.
- `routes`: every screen in the order a user meets them, as a list or as a function of the app folder that reads the
  screens from the app's own tree. Each route has a file-safe `name`, a `url` and an optional `rootId` (the React
  Native testID of the screen's root, which the `appium` driver waits for).
- `metro.defaultPort`: a React Native app whose Debug build loads its JavaScript from Metro. Without `metro`, `up`
  always runs the Release build.
- `platforms`: one entry per platform. A command for a platform the project does not name refuses.
- `platforms.ios.bundleId`: a string, or a function of the app folder (an Expo app reads its `app.json`).
- `platforms.ios.build`: `workspace` (relative to the app folder), `scheme`, `configuration` (`Debug` or `Release`),
  `productName` (the `.app` name), and optional `buildSettings` (extra `KEY=value` settings, such as a deployment
  target a dependency needs).
- `platforms.ios.buildInputs`: `native` and `js` globs, relative to the app folder, that decide when a build is stale.
- `platforms.ios.defaultWidth`: the phone width `up` uses without `--width`.
- `platforms.ios.firstRun`: `privacy` (simctl services), `idbApprove` (idb services), `scheme` (the URL scheme whose
  "Open in" prompt idb pre-approves) and `defaults` (user defaults written into the app's domain, such as a dev menu
  that would open at launch).
- `platforms.ios.release`: `prepare` (steps before the archive, each with `title`, `command`, optional `cwd` relative
  to the app folder, and `env`; a project with a checked-in native project names none) and `pods`.
- `platforms.android`: `packageName` (a Java package name), optional `activity` and `apk` (relative to the app folder).

### Environment variables

| Variable | What it does |
|---|---|
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | the Android SDK root, in that order; default `~/Library/Android/sdk` |
| `APPIUM_HOME` | the Appium home with the installed drivers; default `~/.appium` |
| `GENESIS_TOOLS_HOME` | moves the `~/.genesis-tools` root |

## For agents

- These commands print JSON with `--json`: `doctor`, `config`, `routes`, `up`, `open`, `capture`, `tour`, `alerts`,
  `logbox`, `first-run`, `devices`, `boot`, `screenshot`, `appium status`, `metro status` and `release --dry-run`.
- An error prints `ERROR: <message>` on stderr and exits 1; `-v` adds the stack. A refusal names the fix (several
  booted simulators, no config, an unknown route, an app that is not installed).
- Exit 1 also means: a failed `doctor` check (the Appium and Android lines are information only), an `up` whose app
  did not fetch its bundle or hit a fatal Metro line, a `tour` with a missing screen, a `logbox` with an entry or a
  fatal Metro line, an `alerts` run with no WDA and no idb, an `appium status` with nothing on the port, and a
  `release` with a missing input.
- Parallel sessions: give each one its own simulator (`--name` or `--udid`), its own `--derived-data` and its own
  `--metro-port`, and always pass `--udid` or `--device`.
- The generic pieces are a library in `@genesiscz/utils/mobile/`: `project` (the config contract and loader),
  `simulator` (simctl, device types and screens, privacy, user defaults, WDA ports), `appium` (the driver check, the
  per-simulator port), `webdriver` (a minimal W3C client over `fetch`), `service` (a detached server with a pidfile),
  `metro`, `android`, `wda` (WebDriverAgent's session-less routes, so a second actor can read the screen while a run
  holds the only Appium session), `alerts` (the alert rule table), `idb`, `a11y` (the XCUITest tree parser, the
  readable tree, the LogBox reader), `session` (picks the simulator, starts its Appium and attaches an XCUITest
  session to the installed app), and `screen-driver` and `capture` (open a screen and save it). `tools e2e` drives the
  same simulator through them.

## Troubleshooting

- **`expo run:ios` stops at "Can't determine id of Simulator app".** Xcode 27 replaced Simulator.app with DeviceHub.
  Build with `tools mobile build` or `tools mobile up`.
- **The simulator shuts down when an Appium session starts.** The XCUITest driver predates DeviceHub. Run
  `appium driver uninstall xcuitest && appium driver install xcuitest@12.22.8`; `doctor` prints the same fix.
- **"N simulators are booted; pass --udid".** The tool never guesses which one is yours. Pass `--udid` (or
  `--device`); `tools mobile devices` lists them.
- **Two agents keep losing their sessions.** They share a WDA or Appium port. Do not pass one `--appium-port` to both;
  each simulator's own port is the default.
- **The simulator reboots, or an open DeviceHub window closes.** `isHeadless` did not match the open UI. Do not open
  or close DeviceHub while a session runs.
- **"Metro already listens on :8091".** A Metro holds the port, and the tool cannot tell which project it serves.
  It can be another project's Metro, or the Metro an earlier `up` started, because `up` never reuses one. Stop it
  (`tools mobile metro stop 8091` stops only one this tool started) or pass another `--metro-port`.
- **`appium start`, `open`, `capture`, `tour` or `logbox` fails with "no XCUITest driver under …".** No XCUITest
  driver is installed in the Appium home (`APPIUM_HOME`, default `~/.appium`). Run
  `appium driver install xcuitest@12.22.8`.
- **A Metro you started yourself serves an old bundle.** Metro with `CI` set never rebuilds. Unset `CI`, or let
  `up` start Metro.
- **`first-run` or `up` reports "an earlier grant hung on this simulator".** The privacy marker is set, and a reboot
  does not fix the hang. Use a simulator with another runtime (`up --name … --os …`), or delete
  `~/.genesis-tools/mobile/privacy-hangs/<udid>` to try the grants again.
- **"no way to read alerts".** WDA is not running and idb is not installed. Run `brew install idb-companion`, or open
  a screen with the `appium` driver first.
- **"xcodebuild succeeded but … is missing".** `platforms.ios.build.productName` does not match the `.app` name.
- **`first-run` refuses the replacement `.app`.** The `.app` is missing, has another bundle id, or has no executable.
  Check `--app-path`, or `--configuration` and `--derived-data`.
- **An Android emulator stays `offline`.** USB debugging is off in the guest (turning "Use developer options" off
  does that, and it survives a reboot). `boot` reports it after two minutes offline instead of waiting. Turn USB
  debugging on in the emulator.

## Related

- [tools e2e](../e2e/README.md) runs end-to-end tests on the same simulators, through the same project config.
