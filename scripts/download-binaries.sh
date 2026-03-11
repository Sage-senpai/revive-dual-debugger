#!/usr/bin/env bash
# download-binaries.sh — fetch CI-built binaries from GitHub Actions artifacts.
#
# Usage:
#   ./scripts/download-binaries.sh              # latest run on main
#   ./scripts/download-binaries.sh <run-id>     # specific workflow run
#
# Requires: gh (GitHub CLI), authenticated

set -euo pipefail

REPO="sage-senpeak/revive-dual-debugger"
WORKFLOW="build-binaries.yml"
ARTIFACT_NAME="revive-binaries-linux"
DEST_DIR="bin/linux"

# ── Resolve run ID ────────────────────────────────────────────────────────────

if [ -n "${1:-}" ]; then
  RUN_ID="$1"
  echo "Using workflow run: $RUN_ID"
else
  echo "Finding latest successful workflow run..."
  RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" \
    --status completed --json databaseId,conclusion \
    --jq '[.[] | select(.conclusion == "success")][0].databaseId')

  if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
    echo "ERROR: No successful runs found for $WORKFLOW"
    echo "Trigger a build with: gh workflow run $WORKFLOW --repo $REPO"
    exit 1
  fi
  echo "Latest successful run: $RUN_ID"
fi

# ── Download artifact ─────────────────────────────────────────────────────────

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading artifact '$ARTIFACT_NAME'..."
gh run download "$RUN_ID" \
  --repo "$REPO" \
  --name "$ARTIFACT_NAME" \
  --dir "$TMPDIR"

# ── Install into bin/<platform> ───────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET="$PROJECT_DIR/$DEST_DIR"

mkdir -p "$TARGET"

# The artifact may contain files at root or under a subdirectory
# Find the actual binaries and copy them
for binary in revive-dev-node eth-rpc; do
  found=$(find "$TMPDIR" -name "$binary" -type f | head -n1)
  if [ -n "$found" ]; then
    cp "$found" "$TARGET/$binary"
    chmod +x "$TARGET/$binary"
    echo "Installed: $TARGET/$binary ($(du -h "$TARGET/$binary" | cut -f1))"
  else
    echo "WARNING: $binary not found in artifact"
  fi
done

echo ""
echo "Done! Binaries installed to $DEST_DIR/"
ls -lh "$TARGET"/
