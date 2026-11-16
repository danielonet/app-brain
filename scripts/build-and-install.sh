#!/usr/bin/env bash
# Builds the App Brain extension into a .vsix and installs it into your local
# VS Code, so you can test it as a real installed extension (not just via
# the F5 "Run App Brain extension" launch configuration).
#
# Usage:
#   scripts/build-and-install.sh                 build, test, package, install
#   scripts/build-and-install.sh --skip-tests    skip `npm test` (it builds first anyway)
#   scripts/build-and-install.sh --package-only  stop after writing app-brain.vsix (used by CI)
#
# After it finishes, reload VS Code (Cmd/Ctrl+Shift+P -> "Developer: Reload Window").

set -euo pipefail

SKIP_TESTS=0
PACKAGE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --package-only) PACKAGE_ONLY=1; SKIP_TESTS=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
echo "==> Working in $ROOT_DIR"

# 0. The server uses node:sqlite, which needs Node >= 22.13 (see .nvmrc, and
#    "engines" in package.json). If the shell resolved an older Node, try to pick
#    up nvm and switch before anything runs.
REQUIRED_NODE="22.13.0"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const need = process.argv[1].split(".").map(Number);
    const have = process.versions.node.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (have[i] > need[i]) process.exit(0);
      if (have[i] < need[i]) process.exit(1);
    }' "$REQUIRED_NODE"
}

if ! node_ok; then
  echo "==> Node not found or older than $REQUIRED_NODE; looking for nvm..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "==> nvm not found; installing it into $NVM_DIR..."
    NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$NVM_INSTALL_URL" | bash
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$NVM_INSTALL_URL" | bash
    else
      echo "!! Neither curl nor wget is available to install nvm." >&2
      echo "   Install one, or install Node >= $REQUIRED_NODE manually." >&2
      exit 1
    fi
  fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh"
    nvm install "$REQUIRED_NODE" >/dev/null
    nvm use "$REQUIRED_NODE" >/dev/null
    echo "==> Switched to Node $(node -v) via nvm"
  fi
  if ! node_ok; then
    echo "!! Could not get Node >= $REQUIRED_NODE. Install it (https://nodejs.org), then re-run." >&2
    exit 1
  fi
fi

# 1. Install dependencies (npm workspaces: installs all three packages).
if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies..."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

# 2. Build (tsc -b over protocol, server, extension) and, unless skipped, test.
if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "==> Building..."
  npm run build
else
  echo "==> Building and testing..."
  npm test
fi

# 3. Stage a self-contained extension folder. The extension needs the server
#    (@app-brain/brain-mcp) and its dependencies at runtime, but those are
#    workspace packages, which vsce cannot follow. So pack them as tarballs and
#    install them, with their production dependencies, next to the extension.
STAGE_DIR="$ROOT_DIR/dist/vsix-stage"
EXT_DIR="$ROOT_DIR/packages/brain-vscode"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/tarballs"

echo "==> Packing workspace packages..."
npm pack --silent --pack-destination "$STAGE_DIR/tarballs" \
  --workspace packages/brain-protocol --workspace packages/brain-mcp >/dev/null

cp -R "$EXT_DIR/out" "$EXT_DIR/media" "$STAGE_DIR/"
# Compiled tests do not belong in the package.
rm -rf "$STAGE_DIR/out/test"
cp "$ROOT_DIR/LICENSE" "$STAGE_DIR/LICENSE"
cp "$ROOT_DIR/README.md" "$STAGE_DIR/README.md"
# The README banner lives in assets/, which is outside the extension.
mkdir -p "$STAGE_DIR/assets" && cp "$ROOT_DIR/assets/banner.png" "$STAGE_DIR/assets/"

node -e '
  const fs = require("fs"), path = require("path");
  const [src, stage] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  const tgz = (prefix) => "file:./tarballs/" + fs.readdirSync(path.join(stage, "tarballs")).find((f) => f.startsWith(prefix));
  pkg.dependencies = {
    ...pkg.dependencies,
    "@app-brain/brain-protocol": tgz("app-brain-brain-protocol-"),
    "@app-brain/brain-mcp": tgz("app-brain-brain-mcp-"),
  };
  // The tarballs are bundled into node_modules below, and the workspace pins the same
  // versions for the server inside brain-mcp, so protocol must resolve to the tarball there too.
  pkg.overrides = { "@app-brain/brain-protocol": pkg.dependencies["@app-brain/brain-protocol"] };
  delete pkg.scripts;
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2));
' "$EXT_DIR" "$STAGE_DIR"

echo "==> Installing production dependencies into the package..."
printf 'tarballs/**\n**/*.map\n**/*.d.ts\n' > "$STAGE_DIR/.vscodeignore"
(cd "$STAGE_DIR" && npm install --omit=dev --no-audit --no-fund --no-package-lock --silent)

# 4. Package with @vscode/vsce.
#    --allow-missing-repository / --skip-license: this is a local dev package, not a
#    marketplace publish.
VSIX_PATH="$ROOT_DIR/app-brain.vsix"
rm -f "$VSIX_PATH"
echo "==> Packaging extension..."
(cd "$STAGE_DIR" && npx --yes @vscode/vsce package \
  --allow-missing-repository --skip-license \
  --baseContentUrl https://github.com/danielonet/app-brain/blob/main \
  --baseImagesUrl https://github.com/danielonet/app-brain/raw/main \
  --out "$VSIX_PATH")
echo "==> Packaged $VSIX_PATH"

if [ "$PACKAGE_ONLY" -eq 1 ]; then
  exit 0
fi

# 5. Find a VS Code CLI to install into.
CODE_BIN=""
for candidate in code code-insiders codium; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE_BIN="$candidate"
    break
  fi
done

if [ -z "$CODE_BIN" ]; then
  echo "!! Could not find a 'code' CLI on PATH."
  echo "   Install the extension manually from VS Code:"
  echo "   Extensions view -> ... menu -> 'Install from VSIX...' -> $VSIX_PATH"
  exit 1
fi

# 6. Install (force overwrites any previously installed version).
echo "==> Installing with '$CODE_BIN --install-extension'..."
"$CODE_BIN" --install-extension "$VSIX_PATH" --force

echo
echo "Done. Reload VS Code (Cmd/Ctrl+Shift+P -> 'Developer: Reload Window')"
echo "or restart it to start using the installed App Brain extension."
