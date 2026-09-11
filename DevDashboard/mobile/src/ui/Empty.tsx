import { Text, View } from "react-native";

interface EmptyProps {
    title?: string;
    hint?: string;
    testID?: string;
}

export function Empty({ title = "Nothing here yet", hint, testID = "empty" }: EmptyProps) {
    return (
        <View
            testID={testID}
            accessibilityLabel={testID}
            className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
        >
            <Text className="text-base text-dd-text-secondary">{title}</Text>
            {hint ? <Text className="text-xs text-dd-text-muted">{hint}</Text> : null}
        </View>
    );
}
