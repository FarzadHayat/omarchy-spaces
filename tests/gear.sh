#!/usr/bin/env bash
# Exercise the actual bar widget in a temporary Wayland window; does not save settings.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
shell_dir=${OMARCHY_PATH:-/usr/share/omarchy}/shell
preview=$(mktemp -d)
trap 'rm -rf -- "$preview"' EXIT
ln -s "$shell_dir/Commons" "$preview/Commons"
ln -s "$shell_dir/Ui" "$preview/Ui"
ln -s "$repo/Spaces.qml" "$preview/Spaces.qml"
ln -s "$repo/SpacesSettings.qml" "$preview/SpacesSettings.qml"
ln -s "$repo/Model.js" "$preview/Model.js"
cp "$repo/tests/gear.test.qml" "$preview/shell.qml"
QT_QPA_PLATFORM=wayland QT_QUICK_BACKEND=software timeout 15 qs -p "$preview"
