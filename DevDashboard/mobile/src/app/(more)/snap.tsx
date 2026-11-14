import type { AgentBoardSession, SnapReceiptDto } from "@dd/contract";
import { Canvas, ImageFormat, Image as SkiaImage, Path, type SkImage, useCanvasRef, useImage } from "@shopify/react-native-skia";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useDashboardClient } from "@/api/client-provider";
import { SessionPicker } from "@/features/agents/components/SessionPicker";
import { useAgentsBoard } from "@/features/agents/hooks";
import { type Stroke, snapToSession, strokePath } from "@/features/snap/queries";
import { idempotencyKey } from "@/lib/idempotency";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

/** The markup colour: red reads on whiteboards, paper and screens alike. */
const INK = "#ef4444";

function Markup({ image, strokes, setStrokes, canvasRef, size }: {
    image: SkImage | null;
    strokes: Stroke[];
    setStrokes: (next: Stroke[]) => void;
    canvasRef: ReturnType<typeof useCanvasRef>;
    size: { width: number; height: number };
}) {
    const live = useRef<Stroke | null>(null);
    const [draft, setDraft] = useState<Stroke | null>(null);
    const pan = Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .onStart((event) => {
            live.current = { points: [{ x: event.x, y: event.y }] };
            setDraft(live.current);
        })
        .onUpdate((event) => {
            if (live.current) {
                live.current = { points: [...live.current.points, { x: event.x, y: event.y }] };
                setDraft(live.current);
            }
        })
        .onEnd(() => {
            if (live.current) {
                setStrokes([...strokes, live.current]);
            }

            live.current = null;
            setDraft(null);
        });

    return (
        <GestureDetector gesture={pan}>
            <Canvas ref={canvasRef} style={size}>
                {image ? <SkiaImage image={image} x={0} y={0} width={size.width} height={size.height} fit="cover" /> : null}
                {[...strokes, ...(draft ? [draft] : [])].map((stroke, index) => (
                    <Path key={index} path={strokePath(stroke)} color={INK} style="stroke" strokeWidth={5} strokeCap="round" strokeJoin="round" />
                ))}
            </Canvas>
        </GestureDetector>
    );
}

/**
 * Snap it to the agent (F24): photograph a whiteboard, a bug on another device or a sketch, circle the spot with a
 * finger, pick a running session and send it. The Mac puts the image on the widget file shelf and into that
 * session's draft, the same as a Mac screenshot.
 */
export default function SnapScreen() {
    const c = useThemeColors();
    const client = useDashboardClient();
    const board = useAgentsBoard();
    const [permission, requestPermission] = useCameraPermissions();
    const camera = useRef<CameraView>(null);
    const canvasRef = useCanvasRef();
    const [photo, setPhoto] = useState<string | null>(null);
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [busy, setBusy] = useState(false);
    const [receipt, setReceipt] = useState<SnapReceiptDto | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    // The photo decodes after it is taken; until it has, a snapshot would send the strokes on an empty canvas.
    const image = useImage(photo, (failure) => setLoadError(failure.message));
    const ready = image !== null && !busy;
    const { width } = useWindowDimensions();
    const size = { width: width - 32, height: Math.round(((width - 32) * 4) / 3) };

    const take = async () => {
        const shot = await camera.current?.takePictureAsync({ quality: 0.7 });

        if (shot?.uri) {
            setPhoto(shot.uri);
            setLoadError(null);
            setStrokes([]);
            setReceipt(null);
        }
    };
    const send = async (session: AgentBoardSession) => {
        if (!session.sessionId || !image) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const snapshot = await canvasRef.current?.makeImageSnapshotAsync();

            if (!snapshot) {
                throw new Error("Could not read the marked-up photo.");
            }

            const jpegBase64 = snapshot.encodeToBase64(ImageFormat.JPEG, 80);
            setReceipt(await snapToSession(client, { jpegBase64, provider: session.provider, sessionId: session.sessionId, idempotencyKey: idempotencyKey() }));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <Stack.Screen options={{ title: "Snap to agent" }} />
            <ScrollView testID="screen-snap" accessibilityLabel="screen-snap" className="flex-1 bg-dd-bg-base" contentContainerClassName="gap-3 p-4">
                <MockBadge />
                {!permission?.granted ? (
                    <Pressable accessibilityRole="button" onPress={() => void requestPermission()} className="items-center rounded-xl py-3" style={{ backgroundColor: c.accentMuted }}>
                        <Text style={{ color: c.accent }}>Allow the camera</Text>
                    </Pressable>
                ) : photo ? (
                    <>
                        <Markup image={image} strokes={strokes} setStrokes={setStrokes} canvasRef={canvasRef} size={size} />
                        <View className="flex-row gap-4">
                            <Pressable accessibilityRole="button" onPress={() => setStrokes(strokes.slice(0, -1))}>
                                <Text style={{ color: c.accent }}>Undo</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" onPress={() => setPhoto(null)}>
                                <Text style={{ color: c.accent }}>Retake</Text>
                            </Pressable>
                        </View>
                        <Text style={{ color: c.textSecondary, fontSize: 13 }}>Send to:</Text>
                        {loadError ? (
                            <Text style={{ color: c.danger, fontSize: 13 }}>{`The photo did not load: ${loadError}. Retake it.`}</Text>
                        ) : image ? null : (
                            <Text style={{ color: c.textMuted, fontSize: 13 }}>Loading the photo…</Text>
                        )}
                        <SessionPicker
                            sessions={(board.data?.sessions ?? []).filter((session) => session.sessionId)}
                            disabled={!ready}
                            testIDPrefix="snap-to-"
                            onPick={(session) => void send(session)}
                        />
                    </>
                ) : (
                    <>
                        <CameraView ref={camera} style={size} facing="back" />
                        <Pressable testID="snap-take" accessibilityRole="button" onPress={() => void take()} className="items-center rounded-xl py-3" style={{ backgroundColor: c.accent }}>
                            <Text style={{ color: c.bgBase, fontWeight: "700" }}>Take the photo</Text>
                        </Pressable>
                    </>
                )}
                {receipt ? (
                    <Text testID="snap-receipt" style={{ color: receipt.attached ? c.accent : c.danger }}>
                        {receipt.error ?? "On the Mac's shelf and in the session's draft."}
                    </Text>
                ) : null}
                {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
            </ScrollView>
        </GestureHandlerRootView>
    );
}
