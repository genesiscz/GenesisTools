import type { MobileProjectConfig } from "../../../src/utils/mobile/project";
import { devDashboardRoutes, SCHEME } from "./adapter";
import { getDevDashboardBundleId } from "./bundle-id";

/** The DevDashboard mobile app for `tools mobile` and `tools e2e`: its build, its screens and its first-run grants. */
export default {
    id: "dev-dashboard",
    title: "DevDashboard mobile",
    appDir: "..",
    routes: devDashboardRoutes,
    metro: { defaultPort: 8081 },
    platforms: {
        ios: {
            bundleId: () => getDevDashboardBundleId(),
            build: {
                workspace: "ios/DevDashboard.xcworkspace",
                scheme: "DevDashboard",
                configuration: "Release",
                productName: "DevDashboard",
                // ExpoRouter's link preview uses an iOS 16 API, so the Pods' iOS 15 target does not compile in Release.
                buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "16.0" },
            },
            buildInputs: {
                native: [
                    "app.json",
                    "app.config.ts",
                    "package.json",
                    "patches/*.patch",
                    "ios/Podfile",
                    "ios/Podfile.lock",
                    "ios/Podfile.properties.json",
                    "ios/DevDashboard/**/*.{swift,m,mm,h,plist,entitlements}",
                    "ios/DevDashboard.xcodeproj/project.pbxproj",
                ],
                js: ["src/**/*.{ts,tsx,js,json}", "assets/**/*", "tailwind.config.js", "babel.config.js", "metro.config.js"],
            },
            // An iPhone 17 / 18 Pro: the width the screens are designed at.
            defaultWidth: 402,
            firstRun: {
                // The QR scanner asks for the camera, the needs-input alerts for notifications; the LAN discovery's local
                // network prompt has no grant anywhere and is answered by the alert watcher.
                idbApprove: ["camera", "notification"],
                scheme: SCHEME,
            },
            release: {
                // The prebuild writes ios/, so the Podfile does not exist yet when the plan is made.
                pods: true,
                // app.config.ts reads the push environment and the build number from these when it writes the native project.
                prepare: ({ buildNumber }) => [
                    {
                        title: "native project (production push environment, build number)",
                        command: ["bunx", "expo", "prebuild", "--platform", "ios", "--no-install"],
                        env: { GT_APS_ENVIRONMENT: "production", GT_BUILD_NUMBER: buildNumber },
                    },
                ],
            },
        },
    },
} satisfies MobileProjectConfig;
