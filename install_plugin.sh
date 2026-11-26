#!/usr/bin/env bash
# Installa (o aggiorna) il plugin Obsidian in un vault.
# Uso: bash install_plugin.sh /percorso/del/tuo/vault [--link]
#   --link  crea link simbolici invece di copiare: dopo un `git pull`
#           il plugin e' gia' aggiornato (basta riavviare Obsidian).
set -euo pipefail
cd "$(dirname "$0")"

VAULT="${1:-}"
if [ -z "$VAULT" ] || [ ! -d "$VAULT/.obsidian" ]; then
    echo "Uso: bash install_plugin.sh /percorso/del/vault [--link]" >&2
    echo "(la cartella deve contenere .obsidian/)" >&2
    exit 1
fi
SRC="$(pwd)/plugin/pen2latex"
DEST="$VAULT/.obsidian/plugins/pen2latex"
mkdir -p "$DEST"
for f in main.js manifest.json styles.css; do
    rm -f "$DEST/$f"
    if [ "${2:-}" = "--link" ]; then
        ln -s "$SRC/$f" "$DEST/$f"
    else
        cp "$SRC/$f" "$DEST/$f"
    fi
done
echo "Plugin installato in $DEST"
echo "In Obsidian: Impostazioni -> Plugin della community -> attiva 'Pen to LaTeX'"
echo "(se era gia' attivo: disattivalo e riattivalo, o riavvia Obsidian)"
