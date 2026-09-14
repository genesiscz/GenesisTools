import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import {
    Eyebrow,
    GhostButton,
    inputClass,
    placeholderColor,
    PrimaryButton,
} from "@/features/connections/components";
import type { SavedConnection } from "@/features/connections/types";
import { Card } from "@/ui/Card";

export interface ConnectionFormValues {
    label: string;
    host: string;
    username: string;
    password: string;
}

/**
 * Inline LAN add/edit form, styled to match the Connect screen's LAN credential card. In "add" mode
 * it captures host + user + pass for a new LAN connection; in "edit" mode it pre-fills label/host/
 * user and treats a blank password as "leave existing password untouched".
 */
export function ConnectionForm({
    mode,
    initial,
    onSubmit,
    onCancel,
}: {
    mode: "add" | "edit";
    initial?: SavedConnection;
    onSubmit: (values: ConnectionFormValues) => void;
    onCancel: () => void;
}) {
    const [label, setLabel] = useState(initial?.label ?? "");
    const [host, setHost] = useState(
        initial ? `${initial.host}:${initial.port}` : "",
    );
    const [username, setUsername] = useState(initial?.username ?? "");
    const [password, setPassword] = useState("");

    const isEdit = mode === "edit";
    const eyebrow = isEdit ? "Edit · connection" : "LAN · new connection";
    const submitLabel = isEdit ? "Save changes" : "Add connection";
    const passwordPlaceholder = isEdit ? "password (leave blank to keep)" : "password";

    function submit(): void {
        onSubmit({
            label: label.trim(),
            host: host.trim(),
            username: username.trim(),
            password,
        });
    }

    return (
        <Card bezel featured className="gap-4">
            <Eyebrow label={eyebrow} />
            <View
                testID={isEdit ? "connection-edit-form" : "connection-add-form"}
                accessibilityLabel={isEdit ? "connection-edit-form" : "connection-add-form"}
                className="gap-3"
            >
                <Text className="text-xs leading-5 text-dd-text-muted">
                    {isEdit
                        ? "Update the label or address for this connection."
                        : "Enter the agent address + credentials to save a LAN connection."}
                </Text>

                <TextInput
                    accessibilityLabel="connection-label"
                    value={label}
                    onChangeText={setLabel}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="label (e.g. Studio Mac)"
                    placeholderTextColor={placeholderColor}
                    className={inputClass}
                />
                <TextInput
                    accessibilityLabel="connection-host"
                    value={host}
                    onChangeText={setHost}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="192.168.1.10:3042"
                    placeholderTextColor={placeholderColor}
                    className={inputClass}
                />
                <TextInput
                    accessibilityLabel="connection-username"
                    value={username}
                    onChangeText={setUsername}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="username"
                    placeholderTextColor={placeholderColor}
                    className={inputClass}
                />
                <TextInput
                    accessibilityLabel="connection-password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    placeholder={passwordPlaceholder}
                    placeholderTextColor={placeholderColor}
                    className={inputClass}
                />

                <PrimaryButton
                    testID="btn-submit-connection"
                    accessibilityLabel="btn-submit-connection"
                    label={submitLabel}
                    onPress={submit}
                />
                <GhostButton
                    testID="btn-cancel-connection"
                    accessibilityLabel="btn-cancel-connection"
                    label="Cancel"
                    onPress={onCancel}
                />
            </View>
        </Card>
    );
}
