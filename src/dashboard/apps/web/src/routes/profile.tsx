import { createFileRoute } from "@tanstack/react-router";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Separator } from "@ui/components/separator";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { AlertTriangle, Calendar, Camera, Check, Github, Link2, Mail, Trash2, User, X } from "lucide-react";
import { useRef, useState } from "react";
import { AuthAlertBanner } from "@/components/auth";
import { DashboardLayout } from "@/components/dashboard";
import { SettingCard, SettingRow } from "@/components/settings";
import { removeAvatarFn, updateAvatarFn } from "@/lib/profile-actions";

export const Route = createFileRoute("/profile")({
    component: ProfilePage,
});

function ProfilePage() {
    const { user } = useAuth();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
    const [avatarLoading, setAvatarLoading] = useState(false);
    const [avatarError, setAvatarError] = useState<string | null>(null);

    const userInitials =
        user?.firstName && user?.lastName
            ? `${user.firstName[0]}${user.lastName[0]}`
            : (user?.email?.substring(0, 2).toUpperCase() ?? "U");

    const displayName =
        user?.firstName && user?.lastName
            ? `${user.firstName} ${user.lastName}`
            : (user?.email?.split("@")[0] ?? "Unknown User");

    const createdAt = user?.createdAt
        ? new Date(user.createdAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
          })
        : "Unknown";

    // avatarUrl state wins over OAuth profile picture
    const displayAvatarSrc = avatarUrl ?? user?.profilePictureUrl ?? undefined;

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];

        if (!file || !user?.id) {
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            setAvatarError("Image must be under 5 MB");
            return;
        }

        const mimeType = file.type as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
        const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

        if (!allowedTypes.has(mimeType)) {
            setAvatarError("Unsupported format. Use JPEG, PNG, WebP, or GIF.");
            return;
        }

        setAvatarLoading(true);
        setAvatarError(null);

        const reader = new FileReader();
        reader.onload = async (ev) => {
            const dataUrl = ev.target?.result as string;
            // Strip the "data:<mime>;base64," prefix
            const fileBase64 = dataUrl.split(",")[1];

            if (!fileBase64) {
                setAvatarError("Failed to read file");
                setAvatarLoading(false);
                return;
            }

            try {
                const result = await updateAvatarFn({
                    data: {
                        userId: user.id,
                        fileBase64,
                        mimeType,
                        origin: window.location.origin,
                    },
                });

                if ("success" in result && result.success && "avatarUrl" in result) {
                    setAvatarUrl(result.avatarUrl);
                } else {
                    setAvatarError("message" in result ? result.message : "Failed to upload avatar");
                }
            } catch (err) {
                setAvatarError(err instanceof Error ? err.message : "Failed to upload avatar");
            } finally {
                setAvatarLoading(false);
                // Reset input so the same file can be re-selected after removal
                if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                }
            }
        };

        reader.onerror = () => {
            setAvatarError("Failed to read file");
            setAvatarLoading(false);
        };

        reader.readAsDataURL(file);
    };

    const handleRemoveAvatar = async () => {
        if (!user?.id) {
            return;
        }

        setAvatarLoading(true);
        setAvatarError(null);

        try {
            const result = await removeAvatarFn({ data: { userId: user.id } });

            if ("success" in result && result.success) {
                setAvatarUrl(null);
            } else {
                setAvatarError("message" in result ? result.message : "Failed to remove avatar");
            }
        } catch (err) {
            setAvatarError(err instanceof Error ? err.message : "Failed to remove avatar");
        } finally {
            setAvatarLoading(false);
        }
    };

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    return (
        <DashboardLayout title="Profile" description="Manage your NEXUS identity">
            <div className="max-w-3xl space-y-6">
                {/* Avatar & Basic Info */}
                <SettingCard
                    title="Profile Information"
                    description="Your public identity within NEXUS"
                    icon={<User className="h-4 w-4" />}
                    tint="primary"
                >
                    {/* Hidden file input */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        onChange={handleFileChange}
                        aria-label="Upload profile picture"
                    />

                    {/* Avatar Section */}
                    <div className="flex items-center gap-6">
                        <div className="relative group">
                            <Avatar className="h-20 w-20 border-2 border-primary/30">
                                <AvatarImage src={displayAvatarSrc} alt={displayName} />
                                <AvatarFallback className="bg-primary/20 text-primary text-xl font-bold">
                                    {userInitials}
                                </AvatarFallback>
                            </Avatar>
                            <button
                                type="button"
                                disabled={avatarLoading}
                                className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer disabled:cursor-not-allowed"
                                onClick={handleUploadClick}
                                aria-label="Change profile picture"
                            >
                                <Camera className="h-6 w-6 text-primary" />
                            </button>
                        </div>
                        <div className="space-y-1">
                            <p className="text-sm text-muted-foreground">Profile Picture</p>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={avatarLoading}
                                    className="border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                                    onClick={handleUploadClick}
                                >
                                    <Camera className="h-3 w-3 mr-2" />
                                    {avatarLoading ? "Uploading…" : "Upload"}
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={avatarLoading || (!avatarUrl && !user?.profilePictureUrl)}
                                    className="text-muted-foreground hover:text-amber-400"
                                    onClick={handleRemoveAvatar}
                                >
                                    Remove
                                </Button>
                            </div>
                        </div>
                    </div>

                    {avatarError && <AuthAlertBanner variant="error" message={avatarError} />}

                    <Separator className="bg-primary/10" />

                    {/* Display Name */}
                    <div className="space-y-2">
                        <Label htmlFor="displayName" className="text-sm flex items-center gap-2">
                            <User className="h-3 w-3 text-primary" />
                            Display Name
                        </Label>
                        <Input
                            id="displayName"
                            defaultValue={displayName}
                            className="bg-card/50 border-primary/20 focus:border-primary/50"
                        />
                        <p className="text-xs text-muted-foreground">This is how you appear across NEXUS</p>
                    </div>

                    {/* Email */}
                    <div className="space-y-2">
                        <Label htmlFor="email" className="text-sm flex items-center gap-2">
                            <Mail className="h-3 w-3 text-primary" />
                            Email Address
                        </Label>
                        <Input
                            id="email"
                            defaultValue={user?.email ?? ""}
                            disabled
                            className="bg-card/50 border-primary/20 opacity-60"
                        />
                        <p className="text-xs text-muted-foreground">
                            Email cannot be changed. Contact support if needed.
                        </p>
                    </div>

                    <Separator className="bg-primary/10" />

                    <div className="flex justify-end">
                        <Button className="bg-primary text-primary-foreground hover:bg-primary/90">Save Changes</Button>
                    </div>
                </SettingCard>

                {/* Account Details */}
                <SettingCard
                    title="Account Details"
                    description="Information about your NEXUS account"
                    icon={<Calendar className="h-4 w-4" />}
                    tint="accent"
                >
                    <SettingRow label="Account Created" description="When you joined NEXUS">
                        <Badge variant="outline" className="border-accent/30 text-accent">
                            {createdAt}
                        </Badge>
                    </SettingRow>

                    <Separator className="bg-accent/10" />

                    <SettingRow label="User ID" description="Your unique identifier">
                        <code className="text-xs bg-card/50 px-2 py-1 rounded border border-accent/20 text-accent font-mono">
                            {user?.id?.substring(0, 16) ?? "N/A"}...
                        </code>
                    </SettingRow>

                    <Separator className="bg-accent/10" />

                    <SettingRow label="Account Status" description="Your current account state">
                        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                            <Check className="h-3 w-3 mr-1" />
                            Active
                        </Badge>
                    </SettingRow>
                </SettingCard>

                {/* Connected Accounts */}
                <SettingCard
                    title="Connected Accounts"
                    description="Link third-party accounts for faster login"
                    icon={<Link2 className="h-4 w-4" />}
                    tint="secondary"
                >
                    {/* Google */}
                    <div className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-white/5">
                                <svg className="h-4 w-4" viewBox="0 0 24 24">
                                    <path
                                        fill="#4285F4"
                                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                    />
                                    <path
                                        fill="#34A853"
                                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                    />
                                    <path
                                        fill="#FBBC05"
                                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                    />
                                    <path
                                        fill="#EA4335"
                                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                    />
                                </svg>
                            </div>
                            <div className="space-y-0.5">
                                <Label className="text-sm">Google</Label>
                                <p className="text-xs text-muted-foreground">Sign in with Google</p>
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="border-secondary/30 text-secondary hover:bg-secondary/10 hover:text-secondary"
                        >
                            Connect
                        </Button>
                    </div>

                    <Separator className="bg-secondary/10" />

                    {/* GitHub */}
                    <div className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-white/5">
                                <Github className="h-4 w-4 text-white" />
                            </div>
                            <div className="space-y-0.5">
                                <Label className="text-sm">GitHub</Label>
                                <p className="text-xs text-muted-foreground">Sign in with GitHub</p>
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:text-purple-400"
                        >
                            Connect
                        </Button>
                    </div>
                </SettingCard>

                {/* Danger Zone */}
                <SettingCard
                    title="Danger Zone"
                    description="Irreversible actions that affect your account"
                    icon={<AlertTriangle className="h-4 w-4" />}
                    tint="destructive"
                >
                    <SettingRow
                        label="Delete Account"
                        description="Permanently remove your account and all associated data"
                    >
                        <Button
                            variant="outline"
                            size="sm"
                            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                            <Trash2 className="h-3 w-3 mr-2" />
                            Delete Account
                        </Button>
                    </SettingRow>

                    <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/20">
                        <div className="flex gap-2">
                            <X className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                            <div className="text-xs text-destructive/80">
                                <p className="font-medium">Warning: This action cannot be undone.</p>
                                <p className="mt-1">
                                    All your data, including timers, projects, and settings will be permanently deleted.
                                    You will not be able to recover your account.
                                </p>
                            </div>
                        </div>
                    </div>
                </SettingCard>
            </div>
        </DashboardLayout>
    );
}
