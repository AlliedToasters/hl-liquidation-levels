#!/usr/bin/env bash
# Install as a user-level systemd service (no root). Run from the repo checkout on the target machine.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null && uv venv .venv -q && uv pip install -q --python .venv/bin/python -r requirements.txt \
  || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
mkdir -p ~/.config/systemd/user
sed "s#%h/liquidation_levels#$(pwd)#g" deploy/liquidation-levels.service > ~/.config/systemd/user/liquidation-levels.service
systemctl --user daemon-reload
systemctl --user enable --now liquidation-levels
# keep the user service running when not logged in
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user status liquidation-levels --no-pager | head -5
echo "dashboard on http://127.0.0.1:8787 — expose on your tailnet with: tailscale serve --bg 8787"
