#!/usr/bin/env bash
# Prepara l'ambiente conda "comer" (CPU) per backend e fine-tuning.
# Uso: bash setup.sh            (dalla cartella del repo)
# Se l'ambiente esiste gia', installa solo cio' che manca.
set -euo pipefail
cd "$(dirname "$0")"

ENV_NAME="${COMER_ENV:-comer}"

find_conda() {
    for c in "$HOME/miniforge3" "$HOME/mambaforge" "$HOME/miniconda3" "$HOME/anaconda3" "/opt/conda"; do
        if [ -f "$c/etc/profile.d/conda.sh" ]; then echo "$c/etc/profile.d/conda.sh"; return; fi
    done
    if command -v conda >/dev/null 2>&1; then
        echo "$(conda info --base)/etc/profile.d/conda.sh"; return
    fi
}

CONDA_SH="$(find_conda || true)"
if [ -z "$CONDA_SH" ]; then
    echo "Conda non trovato. Installa Miniforge: https://github.com/conda-forge/miniforge" >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$CONDA_SH"

if ! conda env list | awk '{print $1}' | grep -qx "$ENV_NAME"; then
    echo "==> Creo l'ambiente conda '$ENV_NAME' (Python 3.8)"
    conda create -y -n "$ENV_NAME" python=3.8
fi
conda activate "$ENV_NAME"

if ! python -c "import torch" 2>/dev/null; then
    echo "==> Installo PyTorch 1.8.1 (CPU)"
    pip install "torch==1.8.1+cpu" "torchvision==0.9.1+cpu" \
        -f https://download.pytorch.org/whl/torch_stable.html \
      || pip install "torch==1.8.1" "torchvision==0.9.1"
fi
echo "==> Installo le altre dipendenze"
pip install "pytorch-lightning==1.4.9" "torchmetrics==0.6.0" "pillow==8.4.0" \
    "numpy<1.24" "setuptools<60" six "protobuf<4"
pip install -r requirements.txt
pip install -e . --no-deps

echo "==> Verifica"
python - <<'PY'
from comer.inference import load_model, ORIGINAL_CKPT
load_model(ORIGINAL_CKPT, threads=1)
print("OK: modello caricato correttamente")
PY
echo
echo "Fatto. Avvia il backend con:  bash run_backend.sh"
