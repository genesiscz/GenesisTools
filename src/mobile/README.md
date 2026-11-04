# tools mobile

Builds, installs and screenshots this repo's mobile apps on an iOS simulator. It knows the Xcode 27 rules: DeviceHub.app
replaced Simulator.app, so Expo's `run:ios` fails, and an Appium XCUITest driver older than 12.13 reboots the simulator.

```bash
tools mobile doctor --appium-port 4733         # Xcode, DeviceHub, the XCUITest driver, Appium, booted simulators
tools mobile apps                               # the apps it knows
tools mobile routes dev-dashboard               # every screen and its deep link
tools mobile build dev-dashboard --udid <udid>  # xcodebuild for the simulator, then simctl install
tools mobile tour dev-dashboard --udid <udid> --appium-port 4733   # one PNG per screen
```

## The tour

`tour` opens each screen by its deep link and saves `<NN>-<route>.png` (default folder
`~/.genesis-tools/mobile/tours/<app>/<time>`; `--out` overrides it, `--only <names...>` picks screens).

- `--driver appium` (the default) opens the link with `mobile: deepLink`, waits up to 15 s for the screen's root element
  (its React Native `testID`), pauses `--settle` ms, dismisses any system alert, and saves the shot. A root that never
  shows is saved as `<NN>-<route>.MISSING.png` and the run exits 1. Start Appium from `/tmp`, never from a repo with a
  hoisted `node_modules`: `cd /tmp && appium --port 4733`.
- `--driver simctl` needs no Appium, but iOS answers every `simctl openurl` with an "Open in <app>?" alert that stays on
  the screen and queues up. Use it only to check a build.

The Appium session pins a WebDriverAgent port per simulator (an FNV-1a hash of the udid, 18100 to 18999), so two
agents on two simulators do not kill each other's WDA, and sets `isHeadless` from whether a simulator UI is open.
Without `--udid` a command uses the only booted simulator and refuses when several are booted, so it never drives
another session's.

## Adding an app

One folder, `src/mobile/apps/<id>/adapter.ts`, exporting a `MobileApp` (`src/mobile/lib/types.ts`): where the app
lives, its bundle id, its xcodebuild workspace and scheme, and its routes. Then one line in `src/mobile/apps/index.ts`.
The DevDashboard adapter reads its routes from the expo-router tree (`src/app/(tabs)` in tab bar order, then
`src/app/(more)`), so a new screen file is in the tour without an edit.

The generic pieces are in `@genesiscz/utils/mobile/`: `simulator` (simctl, WDA ports, the UI client), `appium` (the
driver version check) and `webdriver` (a minimal W3C client over `fetch`).
