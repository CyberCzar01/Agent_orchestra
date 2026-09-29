#!/bin/bash
# Собирает «Agent Builder.app» в корне репозитория: универсальный (Apple Silicon + Intel),
# с сервером и интерфейсом из app/ внутри пакета. Нужны Xcode Command Line Tools.
#
#   bash build.sh            — собрать
#   bash build.sh --install  — собрать, поставить в ~/Applications и положить ярлык на рабочий стол
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/Agent Builder.app"
VERSION="1.0.0"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v swiftc >/dev/null || { echo "Нужен swiftc: xcode-select --install"; exit 1; }

# Значок пересобирается из app/static/icon.svg, если есть rsvg-convert и svg новее.
ICNS="$ROOT/native/AppIcon.icns"
if command -v rsvg-convert >/dev/null && [ "$ROOT/app/static/icon.svg" -nt "$ICNS" ]; then
  echo "Рисую значок…"
  ICONSET="$WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    rsvg-convert -w "$size" -h "$size" "$ROOT/app/static/icon.svg" -o "$ICONSET/icon_${size}x${size}.png"
    rsvg-convert -w $((size * 2)) -h $((size * 2)) "$ROOT/app/static/icon.svg" -o "$ICONSET/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$ICONSET" -o "$ICNS"
fi

echo "Компилирую окно приложения (arm64 + x86_64)…"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12" \
    -framework Cocoa -framework WebKit "$ROOT/native/main.swift" -o "$WORK/agent-builder-$arch"
done
lipo -create -output "$WORK/Agent Builder" "$WORK/agent-builder-arm64" "$WORK/agent-builder-x86_64"

echo "Собираю пакет…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "$WORK/Agent Builder" "$APP/Contents/MacOS/Agent Builder"
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/app/server.py" "$APP/Contents/Resources/app/server.py"
cp -R "$ROOT/app/static" "$APP/Contents/Resources/app/static"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agent Builder</string>
  <key>CFBundleDisplayName</key><string>Agent Builder</string>
  <key>CFBundleIdentifier</key><string>io.github.cyberczar01.agent-builder</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Agent Builder</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Конструктор мультиагентных систем для Claude Code · MIT</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# Подпись без сертификата разработчика: без неё macOS на Apple Silicon не запустит программу.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Готово: $APP"

if [ "${1:-}" = "--install" ]; then
  DEST="$HOME/Applications/Agent Builder.app"
  LINK="$HOME/Desktop/Agent Builder.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
  if [ -L "$LINK" ] || [ ! -e "$LINK" ]; then ln -sfn "$DEST" "$LINK"; fi
  echo "Установлено: $DEST (ярлык на рабочем столе)"
fi
