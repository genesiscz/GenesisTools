import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

export function QrScanner({ onScanned }: { onScanned: (data: string) => void }) {
    const c = useThemeColors();
    const [permission, requestPermission] = useCameraPermissions();
    const [scannedOnce, setScannedOnce] = useState(false);

    if (!permission) {
        return (
            <Text accessibilityLabel="qr-scanner-loading" className="text-sm text-dd-text-secondary">
                Loading camera…
            </Text>
        );
    }

    if (!permission.granted) {
        return (
            <View accessibilityLabel="qr-scanner-permission" className="gap-3 p-4">
                <Text className="text-sm text-dd-text-secondary">Camera access is needed to scan the pairing QR.</Text>
                <Pressable
                    accessibilityLabel="qr-grant-permission"
                    onPress={requestPermission}
                    className="rounded-2xl border px-4 py-3 active:opacity-80"
                    style={{ borderCurve: "continuous", borderColor: c.accent, backgroundColor: c.accentMuted }}
                >
                    <Text className="text-center text-sm font-semibold text-dd-accent-from">Grant camera access</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <CameraView
            accessibilityLabel="qr-scanner-camera"
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
                if (scannedOnce) {
                    return;
                }

                setScannedOnce(true);
                onScanned(data);
            }}
        />
    );
}
