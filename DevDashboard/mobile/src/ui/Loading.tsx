import { ActivityIndicator, Text, View } from "react-native";

interface LoadingProps {
    label?: string;
    testID?: string;
}

export function Loading({ label = "Loading…", testID = "loading" }: LoadingProps) {
    return (
        <View
            testID={testID}
            accessibilityLabel={testID}
            className="flex-1 items-center justify-center gap-3 bg-dd-bg-base p-6"
        >
            <ActivityIndicator />
            <Text className="text-sm text-dd-text-secondary">{label}</Text>
        </View>
    );
}
