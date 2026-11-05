import type { ConfigContext, ExpoConfig } from "expo/config";
import { withEntitlementsPlist } from "expo/config-plugins";

// Push (F2): the app receives remote notices. The expo-notifications plugin writes `aps-environment` (its `mode`), and
// this adds the time-sensitive entitlement. A device build then needs a push-capable provisioning profile (Xcode's
// automatic signing makes one). Applied to the config object rather than listed in `plugins`: an ExpoConfig plugin entry is a serializable `name`
// or `[name, props]` pair, never an inline mod function.
const withTimeSensitiveEntitlement = (config: ExpoConfig): ExpoConfig =>
    withEntitlementsPlist(config, (mod) => {
        mod.modResults["com.apple.developer.usernotifications.time-sensitive"] = true;
        return mod;
    });

/** `tools mobile release` sets `GT_APS_ENVIRONMENT=production`, so a TestFlight build gets production tokens. */
const APS_MODE = process.env.GT_APS_ENVIRONMENT === "production" ? "production" : "development";

const FACE_ID_PERMISSION = "Confirm an act that cannot be undone, such as stopping an agent session on your Mac.";

// Dynamic config (plan 02). Expo loads the static `app.json` first and passes it in as
// `config`; we MERGE the transport/trust native requirements onto it so no app.json key is
// lost. Adds: iOS Bonjour (`_devdashboard._tcp`) + local-network + camera usage strings;
// Android INTERNET / network-state / Wi-Fi-multicast / camera permissions; the
// `expo-camera` config plugin (zeroconf is autolinked — see the note on `plugins` below); and
// the `devdashboard` deep-link scheme used by the pairing QR.
const CAMERA_PERMISSION = "Scan the pairing QR shown by the DevDashboard agent.";
// The walkie-talkie (F12) records a short clip for an agent; the Mac transcribes it. Foreground only.
const MICROPHONE_PERMISSION = "Record a short voice message for an agent; your Mac turns it into text.";

export default ({ config }: ConfigContext): ExpoConfig => {
    const existingScheme = config.scheme;
    const schemes = Array.isArray(existingScheme)
        ? [...existingScheme, "devdashboard"]
        : existingScheme
          ? [existingScheme, "devdashboard"]
          : "devdashboard";

    return withTimeSensitiveEntitlement({
        ...config,
        name: config.name ?? "DevDashboard",
        slug: config.slug ?? "devdashboard-mobile",
        scheme: schemes,
        ios: {
            ...config.ios,
            // Each upload needs a higher build number; `tools mobile release` sets one from the clock.
            ...(process.env.GT_BUILD_NUMBER ? { buildNumber: process.env.GT_BUILD_NUMBER } : {}),
            infoPlist: {
                ...config.ios?.infoPlist,
                NSBonjourServices: ["_devdashboard._tcp"],
                NSLocalNetworkUsageDescription: "DevDashboard discovers your Mac's agent on the local network.",
                NSCameraUsageDescription: CAMERA_PERMISSION,
            },
        },
        android: {
            ...config.android,
            permissions: [
                ...(config.android?.permissions ?? []),
                "android.permission.INTERNET",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.ACCESS_WIFI_STATE",
                "android.permission.CHANGE_WIFI_MULTICAST_STATE",
                "android.permission.CAMERA",
            ],
        },
        // NOTE: `react-native-zeroconf` is a plain autolinked native module — it ships NO
        // config plugin (`app.plugin.js`), so it must NOT appear in `plugins` (Expo errors).
        // Its requirements are satisfied by the iOS `infoPlist` (NSBonjourServices +
        // NSLocalNetworkUsageDescription) and the Android `permissions` above.
        plugins: [
            ...(config.plugins ?? []),
            ["expo-camera", { cameraPermission: CAMERA_PERMISSION }],
            ["expo-audio", { microphonePermission: MICROPHONE_PERMISSION, enableBackgroundRecording: false }],
            ["expo-local-authentication", { faceIDPermission: FACE_ID_PERMISSION }],
            // Background remote notifications: a silent push takes an answered notice off the lock screen.
            ["expo-notifications", { mode: APS_MODE, enableBackgroundRemoteNotifications: true }],
        ],
    });
};
