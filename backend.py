"""
Backend locale per riconoscimento LaTeX da formule scritte a mano, con CoMER
(modello addestrato su CROHME, quindi pensato apposta per manoscritto).

Va eseguito DENTRO l'ambiente conda creato da setup_comer.sh:

    source ~/miniforge3/etc/profile.d/conda.sh
    conda activate comer
    cd ~/comer-project/CoMER
    python backend_comer.py

Server su http://127.0.0.1:5005 (stessa porta/API del vecchio backend pix2tex,
così il plugin Obsidian non deve cambiare nulla).
"""

import base64
import io
import json
import logging
import os
import uuid
from datetime import datetime, timezone

import numpy as np
import torch
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image, ImageOps
from torchvision.transforms import ToTensor

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pen2latex-comer")

app = Flask(__name__)
CORS(app)

# Cartella dove si accumulano gli esempi (immagine + LaTeX confermato/corretto)
# per un futuro fine-tuning del modello.
DATASET_DIR = os.environ.get("PEN2LATEX_DATASET_DIR", "dataset")
DATASET_IMAGES_DIR = os.path.join(DATASET_DIR, "images")
os.makedirs(DATASET_IMAGES_DIR, exist_ok=True)

# Path del checkpoint pre-addestrato incluso nel repo CoMER.
# Se lanci lo script da dentro la cartella CoMER (come da istruzioni sopra),
# questo path relativo funziona così com'è.
CKPT_PATH = os.environ.get(
    "COMER_CKPT",
    "lightning_logs/version_0/checkpoints/epoch=151-step=57151-val_ExpRate=0.6365.ckpt",
)

# Soglia di binarizzazione: sopra e' inchiostro (chiaro), sotto e' sfondo
# (scuro) -- coerente con la polarita' scoperta empiricamente (punto 2 in
# decode_image). Scala 0-255.
BINARIZE_THRESHOLD = 100
# Padding (in pixel) aggiunto attorno al contenuto dopo il crop automatico.
CROP_PADDING = 20

# Dimensione massima (lato piu' lungo, in pixel) dopo il crop. Le immagini
# di CROHME sono piccole (es. 249x144); una foto da fotocamera puo' essere
# migliaia di pixel e far esplodere i tempi di inferenza su CPU.
MAX_DIMENSION = 400

_model = None
_vocab = None


def get_model():
    global _model, _vocab
    if _model is None:
        log.info("Carico il checkpoint CoMER da %s ...", CKPT_PATH)
        from comer.datamodule import vocab
        from comer.lit_comer import LitCoMER

        model = LitCoMER.load_from_checkpoint(CKPT_PATH)
        model = model.eval()
        model = model.to(torch.device("cpu"))

        _model = model
        _vocab = vocab
        log.info("Modello CoMER caricato (CPU).")
    return _model, _vocab


def decode_image(data_url_or_b64: str) -> Image.Image:
    """Accetta sia 'data:image/png;base64,....' sia solo la stringa base64.
    Ritorna un'immagine 'L' (scala di grigi) pulita e normalizzata come si
    aspetta CoMER: sfondo scuro, inchiostro chiaro, ritagliata attorno al
    contenuto.
    """
    if "," in data_url_or_b64:
        data_url_or_b64 = data_url_or_b64.split(",", 1)[1]
    raw = base64.b64decode(data_url_or_b64)
    img = Image.open(io.BytesIO(raw))

    # 1. Gestisci il canale alpha PRIMA di convertire a scala di grigi.
    #    I pixel trasparenti vanno trattati come "sfondo". Compositiamo su
    #    NERO (non bianco!) perche' il formato canonico atteso dal modello
    #    e' sfondo scuro / inchiostro chiaro (vedi punto 2 sotto).
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        background = Image.new("RGBA", img.size, (0, 0, 0, 255))
        img = Image.alpha_composite(background, img)

    img = img.convert("L")

    # 2. Normalizza la polarita'. CONFERMATO EMPIRICAMENTE (testando
    #    l'immagine ufficiale del repository CoMER, che ha luminosita'
    #    media ~17 e va data al modello COSI' COM'E', senza invertire):
    #    il formato atteso e' sfondo SCURO con inchiostro CHIARO, non il
    #    contrario. Se riceviamo un'immagine a sfondo chiaro (es. foto/scan
    #    di carta bianca), la invertiamo per portarla al formato giusto.
    arr = np.array(img)
    mean_brightness = arr.mean()
    if mean_brightness > 127:
        log.info(
            "Sfondo chiaro rilevato (media=%.1f), inverto: il modello vuole "
            "sfondo scuro / inchiostro chiaro.", mean_brightness
        )
        img = ImageOps.invert(img)
        arr = np.array(img)

    # 3. Binarizza: l'inchiostro sono i pixel CHIARI (valore alto), lo
    #    sfondo i pixel SCURI (valore basso) -- coerente col punto 2.
    arr = np.where(arr > BINARIZE_THRESHOLD, 255, 0).astype(np.uint8)

    # 4. Ritaglia attorno al contenuto (bounding box dei pixel di
    #    inchiostro, cioe' quelli CHIARI) con un margine.
    ink_rows, ink_cols = np.where(arr > 128)
    if len(ink_rows) > 0:
        top, bottom = ink_rows.min(), ink_rows.max()
        left, right = ink_cols.min(), ink_cols.max()
        top = max(0, top - CROP_PADDING)
        left = max(0, left - CROP_PADDING)
        bottom = min(arr.shape[0], bottom + CROP_PADDING)
        right = min(arr.shape[1], right + CROP_PADDING)
        arr = arr[top:bottom, left:right]
    else:
        log.warning("Nessun tratto di inchiostro rilevato nell'immagine.")

    img = Image.fromarray(arr, mode="L")

    # 5. Ridimensiona se troppo grande (es. foto da fotocamera/scanner),
    #    mantenendo le proporzioni. Fondamentale per i tempi di inferenza:
    #    su CPU un'immagine da migliaia di pixel puo' mettere il modello
    #    in ginocchio (richieste che sembrano "bloccate" ma stanno solo
    #    calcolando per minuti).
    w, h = img.size
    longest_side = max(w, h)
    if longest_side > MAX_DIMENSION:
        scale = MAX_DIMENSION / longest_side
        new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
        log.info("Ridimensiono da %s a %s (lato max %dpx)", img.size, new_size, MAX_DIMENSION)
        img = img.resize(new_size, Image.LANCZOS)

    return img


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "backend": "comer"})


@app.route("/predict", methods=["POST"])
def predict():
    """
    Body JSON atteso:
    { "image": "data:image/png;base64,AAAA..." }

    Risposta:
    { "latex": "x ^ { 2 } = \\sum ..." }
    oppure in caso di errore:
    { "error": "messaggio" }  (HTTP 400/500)
    """
    payload = request.get_json(silent=True)
    if not payload or "image" not in payload:
        return jsonify({"error": "campo 'image' mancante nel body JSON"}), 400

    try:
        img = decode_image(payload["image"])
    except Exception as e:
        log.exception("Errore decodifica immagine")
        return jsonify({"error": f"immagine non valida: {e}"}), 400

    try:
        model, vocab = get_model()
        with torch.no_grad():
            tensor = ToTensor()(img)  # shape [1, H, W]
            mask = torch.zeros_like(tensor, dtype=torch.bool)
            hyp = model.approximate_joint_search(tensor.unsqueeze(0), mask)[0]
            latex = vocab.indices2label(hyp.seq)
    except Exception as e:
        log.exception("Errore durante l'inferenza")
        return jsonify({"error": f"errore inferenza: {e}"}), 500

    log.info("Riconosciuto: %s", latex)
    return jsonify({"latex": latex})


@app.route("/save_correction", methods=["POST"])
def save_correction():
    """
    Salva un esempio (immagine + LaTeX confermato/corretto dall'utente) per
    il futuro fine-tuning. Va chiamato ogni volta che l'utente conferma
    l'inserimento nel plugin, sia che abbia corretto il testo sia che
    l'abbia lasciato invariato -- in entrambi i casi e' un esempio valido
    "immagine -> LaTeX corretto".

    Body JSON atteso:
    {
      "image": "data:image/png;base64,....",   # immagine RAW del canvas,
                                                 # non quella preprocessata
      "predicted": "...",                       # output originale del modello
      "corrected": "..."                        # testo finale confermato dall'utente
    }
    """
    payload = request.get_json(silent=True)
    if not payload or "image" not in payload or "corrected" not in payload:
        return jsonify({"error": "campi 'image' e 'corrected' richiesti"}), 400

    try:
        data_url = payload["image"]
        b64data = data_url.split(",", 1)[1] if "," in data_url else data_url
        raw = base64.b64decode(b64data)
    except Exception as e:
        log.exception("Errore decodifica immagine per il salvataggio")
        return jsonify({"error": f"immagine non valida: {e}"}), 400

    image_id = f"{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    image_rel_path = os.path.join("images", f"{image_id}.png")
    image_abs_path = os.path.join(DATASET_DIR, image_rel_path)

    try:
        with open(image_abs_path, "wb") as f:
            f.write(raw)
    except Exception as e:
        log.exception("Errore salvataggio immagine")
        return jsonify({"error": f"impossibile salvare l'immagine: {e}"}), 500

    record = {
        "id": image_id,
        "image_file": image_rel_path,
        "predicted": payload.get("predicted", ""),
        "corrected": payload["corrected"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    jsonl_path = os.path.join(DATASET_DIR, "corrections.jsonl")
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    log.info("Esempio salvato (%s): predetto=%r confermato=%r",
              image_id, record["predicted"], record["corrected"])
    return jsonify({"status": "ok", "id": image_id})


if __name__ == "__main__":
    get_model()  # carico subito, così la prima richiesta è veloce
    app.run(host="127.0.0.1", port=5005, debug=False)