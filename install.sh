#!/bin/sh
set -eu

REPOSITORY="${CODER_COUNCIL_REPOSITORY:-preraktrivedi7/coder-council}"
REF="${CODER_COUNCIL_REF:-main}"
PROJECT_ROOT="${CODER_COUNCIL_PROJECT_ROOT:-$(pwd)}"
INSTALL_ROOT="${CODER_COUNCIL_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/coder-council}"
BIN_DIR="${CODER_COUNCIL_BIN_DIR:-$HOME/.local/bin}"
SOURCE_DIR="${CODER_COUNCIL_SOURCE_DIR:-}"
STAGING=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Coder Council installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
    rm -rf -- "$STAGING"
  fi
}

trap cleanup EXIT HUP INT TERM

for command in node npm; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required (found $(node --version))"

case "$INSTALL_ROOT" in
  ""|/|"$HOME"|"$HOME/"|"$HOME/.local"|"$HOME/.local/") fail "refusing unsafe install path: $INSTALL_ROOT" ;;
esac

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/coder-council-install.XXXXXX")"
SOURCE="$STAGING/source"
mkdir -p "$SOURCE"

say "==> Downloading Coder Council"
if [ -n "$SOURCE_DIR" ]; then
  [ -d "$SOURCE_DIR" ] || fail "CODER_COUNCIL_SOURCE_DIR is not a directory"
  cp -R "$SOURCE_DIR/." "$SOURCE/"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v tar >/dev/null 2>&1 || fail "tar is required"
  curl -fsSL "https://github.com/$REPOSITORY/archive/refs/heads/$REF.tar.gz" |
    tar -xz -C "$SOURCE" --strip-components=1
fi

[ -f "$SOURCE/package.json" ] || fail "download did not contain a Coder Council package"

say "==> Building the VS Code extension"
npm --prefix "$SOURCE/extensions/vscode" install --ignore-scripts --no-audit --no-fund
npm --prefix "$SOURCE/extensions/vscode" run check
npm --prefix "$SOURCE/extensions/vscode" test
npm --prefix "$SOURCE/extensions/vscode" run package
npm --prefix "$SOURCE/extensions/vscode" prune --omit=dev --ignore-scripts --no-audit --no-fund

mkdir -p "$(dirname "$INSTALL_ROOT")" "$BIN_DIR"
if [ -e "$INSTALL_ROOT" ]; then
  BACKUP="$INSTALL_ROOT.previous-$(date +%Y%m%d%H%M%S)"
  say "==> Preserving the previous installation at $BACKUP"
  mv "$INSTALL_ROOT" "$BACKUP"
fi
mv "$SOURCE" "$INSTALL_ROOT"

for name in coder-council council; do
  destination="$BIN_DIR/$name"
  if [ -e "$destination" ] && [ ! -L "$destination" ]; then
    say "==> Keeping existing file at $destination"
  else
    ln -sfn "$INSTALL_ROOT/bin/council.js" "$destination"
  fi
done

VSIX="$INSTALL_ROOT/artifacts/coder-council-vscode-0.3.1.vsix"
if [ "${CODER_COUNCIL_SKIP_EXTENSION:-0}" != "1" ] && command -v code >/dev/null 2>&1; then
  say "==> Installing Coder Council for VS Code"
  code --install-extension "$VSIX" --force
else
  say "==> VS Code launcher not found; install this VSIX manually: $VSIX"
fi

say "==> Configuring this project with free/local routes"
"$BIN_DIR/coder-council" setup --root "$PROJECT_ROOT"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "==> Add Coder Council to your PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

say "==> Coder Council installed successfully"
say "    Open VS Code, select the Coder Council icon, and choose Open coding workspace."
