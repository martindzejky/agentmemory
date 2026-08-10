#!/bin/sh
set -eu

# Cloud dev install script. Runs when an agent runs in the cloud.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTFILES="${HOME}/.agentfiles"
NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"

# pull latest agentfiles
if [ ! -d "$AGENTFILES/.git" ]; then
  echo "agentfiles not found at $AGENTFILES" >&2
  exit 1
fi

git -C "$AGENTFILES" fetch origin master
git -C "$AGENTFILES" checkout -B master origin/master
HOME="$HOME" "$AGENTFILES/install"

# set up nvm (Node 24). Put nvm's bin first so cloud shims like
# /exec-daemon/node do not win over the intended runtime.
. "$NVM_DIR/nvm.sh"
nvm use 24
NODE_BIN_DIR="$(dirname "$(nvm which current)")"
export PATH="${NODE_BIN_DIR}:${PATH}"

# Lockfiles are gitignored in this repo, so npm ci cannot be used.
# Match .github/workflows/ci.yml.
cd "$ROOT"
npm install --legacy-peer-deps --no-audit --no-fund
