#!/bin/bash
set -euo pipefail

# ==============================================================
# opencode-bundle installer
# Run: curl -fsSL https://raw.githubusercontent.com/YOU/opencode-bundle/main/install.sh | bash
# ==============================================================

# --- EDIT THIS before uploading to your GitHub repo ---
REPO_OWNER="andresgarca361"
REPO_NAME="ocode"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO_OWNER/$REPO_NAME/$BRANCH"

# --- Paths ---
OPENCODE_DIR="$HOME/.opencode"
OPENCODE_BIN="$OPENCODE_DIR/bin"
PROXY_DIR="$OPENCODE_DIR/proxy"
LOCAL_BIN="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/opencode"
AUTH_DIR="$HOME/.local/share/opencode"

echo "=== opencode-bundle installer ==="
echo ""

# --- 1. Detect architecture ---
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ZIP_NAME="opencode-darwin-x64.zip" ;;
  arm64)  ZIP_NAME="opencode-darwin-arm64.zip" ;;
  *)      echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# --- 2. Create directories ---
mkdir -p "$OPENCODE_BIN" "$PROXY_DIR" "$LOCAL_BIN" "$CONFIG_DIR" "$AUTH_DIR"

# --- 3. Install opencode binary ---
if [ -f "$OPENCODE_BIN/opencode" ]; then
  echo "[existing] opencode binary found at $OPENCODE_BIN/opencode"
else
  echo "[download] opencode binary ($ZIP_NAME)..."
  TMP_ZIP="$(mktemp -d)/opencode.zip"
  curl -fsSL "https://github.com/anomalyco/opencode/releases/latest/download/$ZIP_NAME" -o "$TMP_ZIP"
  TMP_EXTRACT="$(mktemp -d)"
  unzip -q "$TMP_ZIP" -d "$TMP_EXTRACT"
  find "$TMP_EXTRACT" -name "opencode" -type f -exec cp {} "$OPENCODE_BIN/opencode" \;
  chmod +x "$OPENCODE_BIN/opencode"
  rm -rf "$TMP_EXTRACT" "$(dirname "$TMP_ZIP")"
  echo "[done] opencode installed at $OPENCODE_BIN/opencode"
fi

# --- 4. Download proxy files ---
echo "[download] proxy.mjs..."
curl -fsSL "$BASE_URL/proxy.mjs" -o "$PROXY_DIR/proxy.mjs"

echo "[download] start.sh..."
curl -fsSL "$BASE_URL/start.sh" -o "$PROXY_DIR/start.sh"

echo "[download] proxy-config.json..."
curl -fsSL "$BASE_URL/proxy-config.json" -o "$PROXY_DIR/proxy-config.json"

chmod +x "$PROXY_DIR/start.sh"

# --- 5. Install ocode wrapper ---
echo "[download] ocode wrapper..."
curl -fsSL "$BASE_URL/ocode" -o "$LOCAL_BIN/ocode"
chmod +x "$LOCAL_BIN/ocode"
echo "[done] ocode installed at $LOCAL_BIN/ocode"

# --- 6. Install opencode.jsonc provider config ---
echo "[download] opencode.jsonc..."
curl -fsSL "$BASE_URL/opencode.jsonc" -o "$CONFIG_DIR/opencode.jsonc"
echo "[done] provider config installed at $CONFIG_DIR/opencode.jsonc"

# --- 7. Fix NODE_EXTRA_CA_CERTS in start.sh ---
if [ -f /opt/homebrew/etc/ca-certificates/cert.pem ]; then
  CA_CERT="/opt/homebrew/etc/ca-certificates/cert.pem"
elif [ -f /usr/local/etc/ca-certificates/cert.pem ]; then
  CA_CERT="/usr/local/etc/ca-certificates/cert.pem"
elif [ -f /etc/ssl/cert.pem ]; then
  CA_CERT="/etc/ssl/cert.pem"
fi
if [ -n "${CA_CERT:-}" ]; then
  if grep -q "NODE_EXTRA_CA_CERTS" "$PROXY_DIR/start.sh" 2>/dev/null; then
    sed -i '' "s|export NODE_EXTRA_CA_CERTS=.*|export NODE_EXTRA_CA_CERTS=\"$CA_CERT\"|" "$PROXY_DIR/start.sh"
  else
    echo "export NODE_EXTRA_CA_CERTS=\"$CA_CERT\"" >> "$PROXY_DIR/start.sh"
  fi
  echo "[done] NODE_EXTRA_CA_CERTS set to $CA_CERT"
else
  echo "[warn] could not find ca-certificates, you may need to set NODE_EXTRA_CA_CERTS manually"
fi

# --- 8. Add ~/.local/bin to PATH ---
SHELL_RC=""
if [ -n "$($SHELL -c 'echo $ZSH_VERSION' 2>/dev/null)" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -n "$($SHELL -c 'echo $BASH_VERSION' 2>/dev/null)" ]; then
  SHELL_RC="$HOME/.bashrc"
fi
if [ -n "$SHELL_RC" ]; then
  if ! grep -q 'export PATH="$HOME/.local/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
    echo "[done] added ~/.local/bin to PATH in $SHELL_RC"
  else
    echo "[ok] ~/.local/bin already in PATH"
  fi
fi

# --- 9. Create auth.json placeholder ---
if [ ! -f "$AUTH_DIR/auth.json" ]; then
  cat > "$AUTH_DIR/auth.json" << 'AUTH_EOF'
{
  "nvidia": {
    "type": "api",
    "key": "YOUR_NVIDIA_API_KEY_HERE"
  }
}
AUTH_EOF
  echo ""
  echo "============================================"
  echo " INSTALL COMPLETE"
  echo "============================================"
  echo ""
  echo "Next steps:"
  echo "  1. Add your NVIDIA API key:"
  echo "     Edit ~/.local/share/opencode/auth.json"
  echo ""
  echo "  2. Set up proxy models:"
  echo "     ocode all"
  echo "     Then open http://127.0.0.1:18080 in your browser"
  echo "     to configure flash & heavy models + RPM"
  echo ""
  echo "  3. Use ocode:"
  echo "     ocode all           # Proxy + Keep-awake + GUI"
  echo "     ocode all-tui       # Proxy + Keep-awake + TUI"
  echo "     ocode gui           # GUI only"
  echo "     ocode tui           # Terminal UI only"
  echo "     ocode -p 'prompt'   # Headless run"
  echo ""
  echo "  Select 'universal-proxy' provider in OpenCode GUI"
  echo "  then pick 'proxy/hybrid' for auto-routing"
  echo "============================================"
else
  echo ""
  echo "============================================"
  echo " INSTALL COMPLETE"
  echo "============================================"
  echo "auth.json already exists, skipping placeholder."
  echo ""
  echo "Usage:"
  echo "  ocode all       # Proxy + Keep-awake + GUI"
  echo "  ocode tui       # Terminal UI"
  echo "  ocode all-tui   # Proxy + Keep-awake + TUI"
  echo "  ocode -p '...'  # Headless run"
  echo ""
  echo "Select 'universal-proxy' > 'proxy/hybrid' in OpenCode GUI"
  echo "============================================"
fi
