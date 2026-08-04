#!/usr/bin/env bash
# Avvia il backend usando automaticamente l'ultimo checkpoint fine-tuned
# se esiste, altrimenti quello originale pre-addestrato.
#
# Uso: bash run_backend.sh
# (va eseguito dalla cartella ~/comer-project/CoMER)
set -e

source "$HOME/miniforge3/etc/profile.d/conda.sh"
conda activate comer

ORIGINAL_CKPT="lightning_logs/version_0/checkpoints/epoch=151-step=57151-val_ExpRate=0.6365.ckpt"
FINETUNED_CKPT="finetuned_checkpoint.ckpt"

if [ -f "$FINETUNED_CKPT" ]; then
    echo "==> Uso il checkpoint fine-tuned: $FINETUNED_CKPT"
    export COMER_CKPT="$FINETUNED_CKPT"
else
    echo "==> Nessun checkpoint fine-tuned trovato, uso l'originale."
    export COMER_CKPT="$ORIGINAL_CKPT"
fi

python backend.py
