import type { ConfigContext, ExpoConfig } from "expo/config";

// Dynamic config (plan 02). Expo loads the static `app.json` first and passes it in as
// `config`; we MERGE the transport/trust native requirements onto it so no app.json key is
// lost. Adds: iOS Bonjour (`_devdashboard._tcp`) + local-network + camera usage strings;
// Android INTERNET / network-state / Wi-Fi-multicast / camera permissions; the
// `react-native-zeroconf` + `expo-camera` config plugins; and the `devdashboard` deep-link
// scheme used by the pairing QR.
export default ({ config }: ConfigContext): ExpoConfig => {
    const existingScheme = config.scheme;
    const schemes = Array.isArray(existingScheme)
        ? [...existingScheme, "devdashboard"]
        : existingScheme
          ? [existingScheme, "devdashboard"]
          : "devdashboard";

    return {
        ...config,
        name: config.name ?? "DevDashboard",
        slug: config.slug ?? "devdashboard-mobile",
        scheme: schemes,
        ios: {
            ...config.ios,
            infoPlist: {
                ...config.ios?.infoPlist,
                NSBonjourServices: ["_devdashboard._tcp"],
                NSLocalNetworkUsageDescription: "DevDashboard discovers your Mac's agent on the local network.",
                NSCameraUsageDescription: "Scan the pairing QR shown by the DevDashboard agent.",
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
            ["expo-camera", { cameraPermission: "Scan the pairing QR shown by the DevDashboard agent." }],
        ],
    };
};
