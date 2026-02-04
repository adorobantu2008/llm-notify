#!/bin/bash
set -e

APP_NAME="LLM Notify Hub"
BUNDLE_ID="com.llmnotifyhub.app"
VERSION="1.0.0"
DIST_DIR=".build/macos"
APP_DIR="$DIST_DIR/$APP_NAME.app"

ARCH="${1:-arm}"  # Default to ARM if not specified

echo "Building macOS app bundle ($ARCH)..."

# Clean previous build
rm -rf "$APP_DIR"

# Create app bundle structure
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleExecutable</key>
    <string>llm-notify-hub</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>CFBundleIconFile</key>
    <string>app.icns</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

# Copy executable
cp "$DIST_DIR/llm-notify-hub" "$APP_DIR/Contents/MacOS/"

# Copy resources (icon)
if [ -d "assets/app-icon.icns" ]; then
    cp "assets/app-icon.icns" "$APP_DIR/Contents/Resources/app.icns"
fi

# Bundle terminal-notifier for macOS notifications (prevents Script Editor popups)
TERMINAL_NOTIFIER_SRC="node_modules/node-notifier/vendor/terminal-notifier.app/Contents/MacOS/terminal-notifier"
if [ -f "$TERMINAL_NOTIFIER_SRC" ]; then
    mkdir -p "$APP_DIR/Contents/Resources/notifier"
    cp "$TERMINAL_NOTIFIER_SRC" "$APP_DIR/Contents/Resources/notifier/terminal-notifier"
    chmod +x "$APP_DIR/Contents/Resources/notifier/terminal-notifier"
fi

# Make executable
chmod +x "$APP_DIR/Contents/MacOS/llm-notify-hub"

# Sign (ad-hoc) to avoid macOS security warnings on local dev
codesign --force --deep --sign - "$APP_DIR"

echo "✓ Built: $APP_DIR"

# Zip for distribution
ZIP_NAME="$DIST_DIR/LLM-Notify-Hub-macOS-$ARCH-$VERSION.zip"
echo "Zipping to $ZIP_NAME..."
pushd "$DIST_DIR" > /dev/null
zip -q -r "LLM-Notify-Hub-macOS-$ARCH-$VERSION.zip" "$APP_NAME.app"
popd > /dev/null

echo "✓ Packaged: $ZIP_NAME"
