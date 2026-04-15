#!/usr/bin/env bash
#
# Install the Zen Sidebar Sync native messaging host.
# Copies the Python script and registers the manifest for Zen Browser.
#
# Usage: ./install.sh [--uninstall]
#
set -euo pipefail

MANIFEST_NAME="zen_sidebar_sync"
EXTENSION_ID="zen-sidebar-sync@luftaquila"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/zen_sidebar_native.py"

# --- Determine paths by platform ---

if [[ "$OSTYPE" == darwin* ]]; then
  INSTALL_DIR="$HOME/Library/Application Support/ZenSidebarSync"
  NMH_DIRS=(
    "$HOME/Library/Application Support/zen/NativeMessagingHosts"
    "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  )
else
  INSTALL_DIR="$HOME/.local/share/zen-sidebar-sync"
  NMH_DIRS=(
    "$HOME/.zen/native-messaging-hosts"
    "$HOME/.mozilla/native-messaging-hosts"
  )
fi

# --- Uninstall ---

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Uninstalling native messaging host..."
  rm -f "$INSTALL_DIR/zen_sidebar_native.py"
  rmdir "$INSTALL_DIR" 2>/dev/null || true
  for dir in "${NMH_DIRS[@]}"; do
    rm -f "$dir/$MANIFEST_NAME.json"
  done
  echo "Done."
  exit 0
fi

# --- Install ---

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "Error: zen_sidebar_native.py not found in $SCRIPT_DIR"
  exit 1
fi

# Check Python 3
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required but not found in PATH"
  exit 1
fi

# Copy host script
mkdir -p "$INSTALL_DIR"
cp "$HOST_SCRIPT" "$INSTALL_DIR/zen_sidebar_native.py"
chmod +x "$INSTALL_DIR/zen_sidebar_native.py"
echo "Installed host script: $INSTALL_DIR/zen_sidebar_native.py"

INSTALLED_PATH="$INSTALL_DIR/zen_sidebar_native.py"

# Create manifest JSON
MANIFEST=$(cat <<EOF
{
  "name": "$MANIFEST_NAME",
  "description": "Zen Sidebar Sync - reads Zen session store for workspace/essential data",
  "path": "$INSTALLED_PATH",
  "type": "stdio",
  "allowed_extensions": ["$EXTENSION_ID"]
}
EOF
)

# Install manifest in all applicable directories
installed=false
for dir in "${NMH_DIRS[@]}"; do
  parent="$(dirname "$dir")"
  if [[ -d "$parent" ]]; then
    mkdir -p "$dir"
    echo "$MANIFEST" > "$dir/$MANIFEST_NAME.json"
    echo "Installed manifest: $dir/$MANIFEST_NAME.json"
    installed=true
  fi
done

# If no parent dirs exist, create the first candidate
if ! $installed; then
  dir="${NMH_DIRS[0]}"
  mkdir -p "$dir"
  echo "$MANIFEST" > "$dir/$MANIFEST_NAME.json"
  echo "Installed manifest: $dir/$MANIFEST_NAME.json"
fi

echo ""
echo "Native messaging host installed successfully."
echo "Restart Zen Browser for changes to take effect."
