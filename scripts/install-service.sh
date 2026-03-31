#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Implenia Kiosk Service Installer ==="
echo "App directory: $APP_DIR"

# Check if PM2 is installed
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2..."
  npm install -g pm2
fi

# Install production dependencies
echo "Installing dependencies..."
cd "$APP_DIR"
npm ci --omit=dev

# Start the server with PM2
echo "Starting kiosk server..."
pm2 start server/dist/index.js \
  --name kiosk-server \
  --cwd "$APP_DIR" \
  --max-restarts 10 \
  --restart-delay 5000

# Configure PM2 to start on boot
if [[ "$(uname)" == "Linux" ]]; then
  echo "Configuring systemd startup..."
  pm2 startup systemd -u "$USER" --hp "$HOME"
elif [[ "$(uname)" == "Darwin" ]]; then
  echo "Configuring launchd startup..."
  pm2 startup launchd -u "$USER" --hp "$HOME"
fi

pm2 save

echo ""
echo "=== Installation complete ==="
echo "  Server: http://localhost:${PORT:-3000}"
echo "  PM2 status: pm2 status"
echo "  PM2 logs:   pm2 logs kiosk-server"
echo ""
echo "To set up kiosk browser autostart on Linux, copy the desktop file:"
echo "  sudo cp $SCRIPT_DIR/kiosk.desktop /etc/xdg/autostart/"
