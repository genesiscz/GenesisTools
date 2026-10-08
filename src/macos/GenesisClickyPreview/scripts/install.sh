#!/bin/bash
set -euo pipefail

# A stable Developer ID requirement lets macOS retain the user's Input Monitoring grant.
package_root="$(cd "$(dirname "$0")/.." && pwd)"
install_root="${CLICKY_PREVIEW_INSTALL_ROOT:-$HOME/Applications}"
app_path="$install_root/Clicky Preview.app"
bundle_id="dev.genesis.clicky.preview"

if /usr/bin/pgrep -f '^.*/Clicky Preview.app/Contents/MacOS/GenesisClickyPreview($| )' >/dev/null; then
    echo 'Quit Clicky Preview before installing. Other app processes will not be stopped.' >&2
    exit 1
fi

identity="${CLICKY_PREVIEW_SIGN_IDENTITY:-}"
if [[ -z "$identity" ]]; then
    identity="$(/usr/bin/security find-identity -v -p codesigning | /usr/bin/awk '/Developer ID Application/ { print $2; exit }')"
fi
if [[ -z "$identity" || "$identity" == '-' ]]; then
    echo 'A Developer ID Application signing identity is required. Set CLICKY_PREVIEW_SIGN_IDENTITY to its SHA.' >&2
    exit 1
fi

/usr/bin/swift build --disable-build-manifest-caching --package-path "$package_root"
bin_path="$(/usr/bin/swift build --package-path "$package_root" --show-bin-path)"
/bin/mkdir -p "$install_root"
staging_root="$(/usr/bin/mktemp -d "$install_root/.clicky-preview.install.XXXXXX")"
staged_app="$staging_root/Clicky Preview.app"
/bin/mkdir -p "$staged_app/Contents/MacOS"
/bin/cp "$bin_path/GenesisClickyPreview" "$staged_app/Contents/MacOS/GenesisClickyPreview"
/bin/cat > "$staged_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.genesis.clicky.preview</string>
<key>CFBundleName</key><string>Clicky Preview</string>
<key>CFBundleDisplayName</key><string>Clicky Preview</string>
<key>CFBundleExecutable</key><string>GenesisClickyPreview</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/bin/codesign --force --sign "$identity" --identifier "$bundle_id" --timestamp=none "$staged_app"
/usr/bin/codesign --verify --strict "$staged_app"
if ! /usr/bin/codesign -dvv "$staged_app" 2>&1 | /usr/bin/grep '^Authority=Developer ID Application:' >/dev/null; then
    echo 'The selected identity is not a Developer ID Application certificate; installation refused.' >&2
    exit 1
fi
new_team="$(/usr/bin/codesign -dv "$staged_app" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/ { print $2 }')"
if [[ -z "$new_team" || "$new_team" == 'not set' ]]; then
    echo 'The staged preview has no signing team; installation refused.' >&2
    exit 1
fi
if [[ -d "$app_path" ]]; then
    old_team="$(/usr/bin/codesign -dv "$app_path" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/ { print $2 }')"
    if [[ "$old_team" != "$new_team" ]]; then
        echo 'Signing team differs from the installed preview; installation refused to preserve its permission identity.' >&2
        exit 1
    fi
    old_requirement="$(/usr/bin/codesign -d -r- "$app_path" 2>&1 | /usr/bin/sed -n 's/^designated => //p')"
    if [[ -z "$old_requirement" ]]; then
        echo 'The installed preview has no designated requirement; installation refused.' >&2
        exit 1
    fi
    /usr/bin/codesign --verify --strict -R "=$old_requirement" "$staged_app"
fi

if /usr/bin/pgrep -f '^.*/Clicky Preview.app/Contents/MacOS/GenesisClickyPreview($| )' >/dev/null; then
    echo 'Clicky Preview launched during the build; installation refused. Quit it and retry.' >&2
    exit 1
fi

previous_app="$staging_root/Previous Clicky Preview.app"
replaced_existing=0
installed_new=0
installation_complete=0
restore_previous() {
    result=$?
    if [[ "$installation_complete" == 0 ]]; then
        if [[ "$installed_new" == 1 && -d "$app_path" ]]; then
            if ! /bin/mv "$app_path" "$staging_root/Failed Clicky Preview.app"; then
                printf 'Could not move the failed install aside. Previous preview remains at: %s\n' "$previous_app" >&2
                return "$result"
            fi
        fi
        if [[ "$replaced_existing" == 1 && -d "$previous_app" ]]; then
            if /bin/mv "$previous_app" "$app_path"; then
                echo 'Installation failed; restored the previous preview.' >&2
            else
                printf 'Rollback failed. Previous preview remains at: %s\n' "$previous_app" >&2
            fi
        fi
    fi
    return "$result"
}
trap restore_previous EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Both paths share a filesystem: each rename installs a complete bundle, never an overlay.
if [[ -d "$app_path" ]]; then
    /bin/mv "$app_path" "$previous_app"
    replaced_existing=1
fi
/bin/mv "$staged_app" "$app_path"
installed_new=1
/usr/bin/codesign --verify --strict "$app_path"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app_path"
installation_complete=1
printf 'Installed: %s\nBundle: %s\nTeam: %s\nBuild and previous bundle: %s\n' "$app_path" "$bundle_id" "$new_team" "$staging_root"
printf 'Launch explicitly, then enable Clicky in Sound settings. This installer does not change permissions.\n'
