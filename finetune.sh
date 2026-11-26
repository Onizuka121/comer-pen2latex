#!/usr/bin/env bash
# Fine-tuning sui tuoi esempi (dataset/), poi riavvia il backend.
# Uso: bash finetune.sh [opzioni di finetuning.py, es. --epochs 15]
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

exec python finetuning.py "$@"
