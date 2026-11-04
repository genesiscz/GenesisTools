# tools mobile

Builds, installs, drives and tests this repo's mobile apps on an iOS simulator. It knows the Xcode 27 rules: DeviceHub.app
replaced Simulator.app, so Expo's `run:ios` fails, and an Appium XCUITest driver older than 12.13 reboots the simulator.

```bash
tools mobile doctor                             # Xcode, DeviceHub, the XCUITest driver, Appium, booted simulators
tools mobile apps                               # the apps it knows
tools mobile routes dev-dashboard               # every screen and its deep link

tools mobile up dev-dashboard --name gt-mine --metro-port 8091 --derived-data /tmp/cc/<you>/dd
tools mobile build dev-dashboard --udid <udid> --configuration Release --derived-data <dir>
tools mobile open dev-dashboard agents --udid <udid>            # a route name, name?query, or a URL
tools mobile capture dev-dashboard agent-session?key=<key> --udid <udid>
tools mobile tour dev-dashboard --udid <udid>   # one PNG per screen
tools mobile alerts dev-dashboard --udid <udid> --watch
tools mobile logbox dev-dashboard --udid <udid> --clear dismiss
tools mobile first-run dev-dashboard --udid <udid> --reset-keychain
tools mobile appium start|stop|status --udid <udid>
tools mobile metro status|stop <port>

tools mobile e2e specs dev-dashboard
tools mobile e2e suite dev-dashboard flows --udid <udid> --agent http://127.0.0.1:3143
tools mobile e2e run dev-dashboard agents.flow --udid <udid> --agent http://127.0.0.1:3143
tools mobile e2e screen dev-dashboard agents --udid <udid> --expect screen-agents agents-live
```

Without `--udid` a command uses the only booted simulator and refuses when several are booted, so it never drives
another session's. Nothing here opens a simulator UI: an open DeviceHub changes `isHeadless` for every Appium session
on the Mac.

## Ports, one set per simulator

Each simulator gets its own ports from an FNV-1a hash of its udid (`udidSlot` in `@genesiscz/utils/mobile/simulator`):
WebDriverAgent 18100 to 18999 (MJPEG 1000 above), Appium 4900 to 4999. XCUITest kills every WDA on its port that
belongs to another simulator, so a shared port makes two agents kill each other's sessions. A command that needs
Appium starts this tool's own server on the simulator's port when none answers (`appium start` does it by hand), from
`/tmp`, with its pidfile and log in `~/.genesis-tools/mobile/appium/<port>.{pid,log}`. `appium stop` stops only a server
this tool started (the pidfile records the process start time). A start refuses an XCUITest driver that predates
DeviceHub.

## up

`up <app>` takes `--udid`, or the simulator named `--name` (default `gt-w<width>`), and creates it when missing: the
iPhone type whose screen is `--width` points wide (default the app's; read from each device type's
`capabilities.plist`, or `profile.plist` before Xcode 27), the newest iOS runtime that runs it (`--os` pins one). It
boots it with `simctl bootstatus -b`. It only ever picks a simulator by its exact name or udid.

- **Build when stale.** A build writes `gt-fingerprint-<configuration>.json` into its DerivedData: the size and
  modification time of every build input (the adapter's `buildInputs`: native files, plus the JavaScript for Release).
  `--build auto` (the default) builds when an input changed, `always` and `never` force it. Give each session its own
  `--derived-data`.
- **Install** when it built, when the app is missing, or when the installed build is not the one in DerivedData (a
  record per simulator in `~/.genesis-tools/mobile/installs/`).
- **First run**: the grants in the adapter's `firstRun` (below).
- **Metro** (Debug, the default for a React Native app; `--release` skips it): `bunx expo start --port <port>` from the
  app folder with `CI` removed (Metro with `CI` set never rebuilds), log in `~/.genesis-tools/mobile/metro/<port>.log`.
  The app is pointed at the port by the `RCT_jsLocation` user default, which React Native's bundle URL provider reads
  before its built-in 8081.
- **Launch**, answer the system alerts the launch raises, and wait (`--launch-timeout`) until Metro's log shows the
  app fetched its bundle. Fatal Metro lines after the launch (a failed bundle, an uncaught error) fail the command.

## open, capture, tour: the screen drivers

All three go through one table (`src/mobile/lib/screen-driver.ts`):

- `appium` (the default) opens a link with `mobile: deepLink`, so iOS shows no "Open in <app>?" alert, and waits up to
  15 s for the screen's root element (its React Native `testID`). The session attaches to the installed app (`noReset`,
  `shouldTerminateApp: false`), so closing it leaves the app on screen.
- `simctl` needs no Appium session: `simctl openurl`, then the alert watcher answers "Open in" for our app.

`capture` saves `<name>.png`, the raw tree `<name>.xml`, `<name>.tree.txt` (one line per element with a testID, words or
a tap target, anonymous containers folded) and `<name>.json` (testIDs, visible words, tap targets, open alerts,
whether a LogBox shows) into `~/.genesis-tools/mobile/captures/<time>/` (or `--out`).

`tour` saves `<NN>-<route>.png` per route (`~/.genesis-tools/mobile/tours/<app>/<time>`); a root that never shows is
saved as `<NN>-<route>.MISSING.png` and the run exits 1.

## alerts

The watcher (`@genesiscz/utils/mobile/alerts`) reads alerts through WebDriverAgent's session-less routes when WDA runs
(a wdio run holds the one Appium session a simulator allows, so a second session is not an option), or through
`idb ui describe-all` when idb is installed. A rule table decides: "Open in" gets Open for our app and Cancel for
another build; notifications, local network, location, tracking and access asks get their allow button for our app;
"Save Password" gets Not Now. An alert of another app, and any alert no rule knows (the app's own `Alert.alert`, such
as a destructive confirmation a spec asserts on), is left alone. An idb tap re-reads the label under the point first,
so it never lands on the app behind an alert someone else answered.

## logbox

Reads React Native's LogBox from the tree: it opens the collapsed toast, walks back to `Log 1 of N` with the header's
unnamed arrows (tapped by position), reads each entry's heading and message, then minimizes it (`--clear dismiss`
dismisses every entry). It also reads Metro's log for the app's port from the newest bundle on. Exit 1 when either has
an entry.

## first-run

Uninstalls and reinstalls the build (`--keep-install` skips it; `--reset-keychain` also empties the simulator's
keychain, since an uninstall keeps an app's keychain items), grants the adapter's `simctl privacy` services, runs
`idb approve` for camera, notifications and the URL scheme where idb is installed, writes the adapter's user defaults,
then launches and answers the first prompts. A `simctl privacy` grant that times out leaves a marker
(`~/.genesis-tools/mobile/privacy-hangs/<udid>`): on some iOS 26.5 simulators one grant wedges installd, and later runs
skip grants there.

## e2e

`e2e run <app> <specs...>` and `e2e suite <app> [name]` (`all`, or a suite the adapter names) run each spec file in
its own `bunx wdio run <config> --spec <file>` from the app folder. The adapter's `e2e.env()` maps the run (udid,
device, iOS version, Appium and WDA ports, bundle id, the spec's run folder, `--agent`) to the runner's environment.
The run folder (`~/.genesis-tools/mobile/runs/<time>/`, or `--out`) holds:

- `<spec>/wdio.log`, `<spec>/results.jsonl` (one line per test, written by the runner's `afterTest`), `<spec>/shots/`
  (a screenshot per failed test), `<spec>/wdio-logs/`;
- `alerts.jsonl` (every alert the watcher answered or left), `device.log` (the app's process log during the run),
  `appium.log` (the server's lines during the run);
- `summary.json` and `summary.md`. A spec fails when its runner exits non-zero, a test fails, or it reported no test.

`e2e screen <app> <route>` opens one screen, captures it, and fails when its root never shows, a `--expect` testID is
missing, a LogBox covers it or an alert is open.

## Adding an app

One folder, `src/mobile/apps/<id>/adapter.ts`, exporting a `MobileApp` (`src/mobile/lib/types.ts`): where the app
lives, its bundle id, its xcodebuild workspace and scheme, its routes, its default width, `metro` for a React Native
app, `buildInputs`, `firstRun`, and `e2e` when it has a wdio suite. Then one line in `src/mobile/apps/index.ts`.
The DevDashboard adapter reads its routes from the expo-router tree (`src/app/(tabs)` in tab bar order, then
`src/app/(more)`), so a new screen file is in the tour, `open` and `capture` without an edit.

The generic pieces are in `@genesiscz/utils/mobile/`: `simulator` (simctl, device types and screens, privacy, user
defaults, WDA ports), `appium` (the driver check, the server), `metro`, `service` (a detached server with a pidfile),
`webdriver` (a minimal W3C client over `fetch`), `wda` (WebDriverAgent's session-less routes), `alerts`, `idb` and
`a11y` (the tree parser, the readable tree, the LogBox reader).
