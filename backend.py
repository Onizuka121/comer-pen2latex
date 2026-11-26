"""
Backend locale di pen2latex: riconoscimento di formule scritte a mano con
CoMER, su CPU.  Lo usa il plugin Obsidian (cartella plugin/).

Avvio (dalla cartella del repo, ambiente conda attivo):

    python backend.py            # oppure: bash run_backend.sh

Server su http://127.0.0.1:5005  (solo locale).

Variabili d'ambiente (tutte opzionali):
    COMER_CKPT             checkpoint da usare. Default: finetuned_checkpoint.ckpt
                           se esiste, altrimenti quello originale CoMER.
    PEN2LATEX_THREADS      core CPU usati per il riconoscimento (default 2:
                           veloce quasi come 4, ma il PC resta reattivo).
    PEN2LATEX_BEAM         ampiezza del beam search (default 5: stessa
                           accuratezza di 10 misurata sui tuoi dati, ~40%
                           di calcolo in meno).
    PEN2LATEX_DATASET_DIR  dove salvare gli esempi per il fine-tuning.
    PEN2LATEX_PORT         porta (default 5005).
    PEN2LATEX_CORS_ORIGINS origini extra autorizzate (separate da virgola).

API:
    GET  /health
    POST /predict          {"image": dataURL}            -> {"latex", "raw", "tokens", "ms"}
                           {"images": [dataURL, ...]}    -> {"results": [...], "ms"}
    POST /save_correction  {"image", "predicted", "corrected"}

Python 3.7 compatibile.
"""

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS

from comer import preprocess as P
from comer.latex_tokens import check_tokens, tokenize_latex, tokens_to_latex

HERE = os.path.dirname(os.path.abspath(__file__))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pen2latex")

ORIGINAL_CKPT = os.path.join(
    HERE, "lightning_logs", "version_0", "checkpoints",
    "epoch=151-step=57151-val_ExpRate=0.6365.ckpt",
)
FINETUNED_CKPT = os.path.join(HERE, "finetuned_checkpoint.ckpt")


def _default_ckpt():
    env = os.environ.get("COMER_CKPT")
    if env:
        return env if os.path.isabs(env) else os.path.join(os.getcwd(), env)
    return FINETUNED_CKPT if os.path.exists(FINETUNED_CKPT) else ORIGINAL_CKPT


CKPT_PATH = _default_ckpt()
THREADS = max(1, int(os.environ.get("PEN2LATEX_THREADS", "2")))
BEAM_SIZE = max(1, int(os.environ.get("PEN2LATEX_BEAM", "5")))
PORT = int(os.environ.get("PEN2LATEX_PORT", "5005"))
MAX_IMAGES_PER_REQUEST = 40

DATASET_DIR = os.environ.get("PEN2LATEX_DATASET_DIR", os.path.join(HERE, "dataset"))
DATASET_IMAGES_DIR = os.path.join(DATASET_DIR, "images")
os.makedirs(DATASET_IMAGES_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
# Solo Obsidian (desktop e mobile) puo' chiamare il backend: un sito web
# aperto nel browser NON deve poter scrivere nel tuo dataset.
_ORIGINS = ["app://obsidian.md", "capacitor://localhost", "http://localhost", "https://localhost"]
_ORIGINS += [o.strip() for o in os.environ.get("PEN2LATEX_CORS_ORIGINS", "").split(",") if o.strip()]
CORS(app, origins=_ORIGINS)

_model = None
_model_lock = threading.Lock()   # una inferenza alla volta: CPU sotto controllo
_file_lock = threading.Lock()


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from comer.inference import load_model

                log.info("Carico il checkpoint %s (thread CPU: %d) ...", CKPT_PATH, THREADS)
                t0 = time.time()
                m = load_model(CKPT_PATH, threads=THREADS)
                # warm-up: la prima inferenza e' sempre piu' lenta
                import numpy as np
                from comer.inference import recognize

                dummy = np.zeros((40, 40), np.uint8)
                dummy[18:22, 10:30] = 255
                recognize(m, dummy, beam_size=1)
                _model = m
                log.info("Modello pronto in %.1fs (beam=%d).", time.time() - t0, BEAM_SIZE)
    return _model


def _known_tokens():
    from comer.datamodule.vocab import vocab

    return set(vocab.word2idx)


def recognize_data_url(data_url: str) -> dict:
    from comer.inference import recognize

    img = P.prepare_bytes(P.decode_data_url(data_url))
    if img is None:
        return {"latex": "", "raw": "", "tokens": [], "empty": True}
    model = get_model()
    with _model_lock:
        tokens, score = recognize(model, img, beam_size=BEAM_SIZE)
    return {
        "latex": tokens_to_latex(tokens),
        "raw": " ".join(tokens),
        "tokens": tokens,
        "score": score,
    }


@app.route("/health", methods=["GET"])
def health():
    info = {
        "status": "ok",
        "backend": "comer",
        "checkpoint": os.path.basename(CKPT_PATH),
        "model_loaded": _model is not None,
        "beam_size": BEAM_SIZE,
        "threads": THREADS,
    }
    if _model is not None:
        from comer.datamodule.vocab import vocab

        info["vocab_size"] = len(vocab)
    return jsonify(info)


@app.route("/predict", methods=["POST"])
def predict():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or ("image" not in payload and "images" not in payload):
        return jsonify({"error": "campo 'image' (o 'images') mancante nel body JSON"}), 400

    t0 = time.time()
    if "images" in payload:
        images = payload["images"]
        if not isinstance(images, list) or not images:
            return jsonify({"error": "'images' deve essere una lista non vuota"}), 400
        if len(images) > MAX_IMAGES_PER_REQUEST:
            return jsonify({"error": "troppe righe (max %d)" % MAX_IMAGES_PER_REQUEST}), 400
        results = []
        for i, data in enumerate(images):
            try:
                results.append(recognize_data_url(data))
            except Exception as e:  # una riga sbagliata non blocca le altre
                log.exception("Errore sulla riga %d", i)
                results.append({"error": str(e)})
        ms = int((time.time() - t0) * 1000)
        log.info("Riconosciute %d righe in %d ms", len(results), ms)
        return jsonify({"results": results, "ms": ms})

    try:
        result = recognize_data_url(payload["image"])
    except (ValueError, OSError) as e:
        log.exception("Immagine non valida")
        return jsonify({"error": "immagine non valida: %s" % e}), 400
    except Exception as e:
        log.exception("Errore durante l'inferenza")
        return jsonify({"error": "errore inferenza: %s" % e}), 500
    result["ms"] = int((time.time() - t0) * 1000)
    log.info("Riconosciuto in %d ms: %s", result["ms"], result["latex"])
    return jsonify(result)


@app.route("/save_correction", methods=["POST"])
def save_correction():
    """Salva un esempio (immagine + LaTeX confermato) per il fine-tuning.

    Body: {"image": dataURL, "predicted": "...", "corrected": "..."}
    L'immagine e' quella della singola formula/riga, come inviata a /predict.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "image" not in payload or "corrected" not in payload:
        return jsonify({"error": "campi 'image' e 'corrected' richiesti"}), 400
    corrected = str(payload["corrected"]).strip()
    if not corrected:
        return jsonify({"error": "'corrected' vuoto"}), 400

    try:
        raw = P.decode_data_url(payload["image"])
        if P.prepare_bytes(raw) is None:
            return jsonify({"error": "immagine vuota, non salvata"}), 400
    except Exception as e:
        return jsonify({"error": "immagine non valida: %s" % e}), 400

    # Avviso (non blocco) se l'etichetta non e' usabile per il training.
    warning = None
    ok, why = check_tokens(tokenize_latex(corrected), _known_tokens() if _model else set())
    if not ok:
        warning = "esempio salvato, ma verra' ignorato dal fine-tuning: %s" % why

    now = datetime.now(timezone.utc)
    image_id = "%s_%s" % (now.strftime("%Y%m%d_%H%M%S"), uuid.uuid4().hex[:8])
    image_rel_path = "images/%s.png" % image_id
    record = {
        "id": image_id,
        "image_file": image_rel_path,
        "predicted": str(payload.get("predicted", "")),
        "corrected": corrected,
        "timestamp": now.isoformat(),
    }
    try:
        with _file_lock:
            with open(os.path.join(DATASET_DIR, image_rel_path), "wb") as f:
                f.write(raw)
            with open(os.path.join(DATASET_DIR, "corrections.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as e:
        log.exception("Errore salvataggio esempio")
        return jsonify({"error": "impossibile salvare: %s" % e}), 500

    log.info("Esempio salvato (%s): predetto=%r confermato=%r%s", image_id,
             record["predicted"], corrected, "  [%s]" % warning if warning else "")
    out = {"status": "ok", "id": image_id}
    if warning:
        out["warning"] = warning
    return jsonify(out)


if __name__ == "__main__":
    get_model()  # carico subito, cosi' la prima richiesta e' veloce
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
