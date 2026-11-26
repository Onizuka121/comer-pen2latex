#!/usr/bin/env bash
# Avvia il backend pen2latex (http://127.0.0.1:5005).
# Usa finetuned_checkpoint.ckpt se esiste, altrimenti il modello originale
# (la scelta la fa backend.py; COMER_CKPT=... per forzarne uno).
# Uso: bash run_backend.sh
set -eo pipefail
cd "$(dirname "$0")"

ENV_NAME="${COMER_ENV:-comer}"
if [ "${CONDA_DEFAULT_ENV:-}" != "$ENV_NAME" ]; then
    for c in "$HOME/miniforge3" "$HOME/mambaforge" "$HOME/miniconda3" "$HOME/anaconda3" "/opt/conda"; do
        if [ -f "$c/etc/profile.d/conda.sh" ]; then
            # shellcheck disable=SC1090
            source "$c/etc/profile.d/conda.sh"
            conda activate "$ENV_NAME"
            break
        fi
    done
fi

exec python backend.py
