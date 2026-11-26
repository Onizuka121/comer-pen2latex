"""
Fine-tuning di CoMER sulla TUA scrittura (o su quella di chiunque usi il
plugin), a partire dagli esempi salvati dal plugin Obsidian:
dataset/corrections.jsonl + dataset/images/*.png

Uso (dalla cartella del repo, con l'ambiente conda attivo):

    python finetuning.py                 # training + validazione, salva il migliore
    python finetuning.py --check         # controlla solo il dataset, non allena
    python finetuning.py --all-data      # usa TUTTI gli esempi (nessuna validazione)

Produce finetuned_checkpoint.ckpt, che il backend usa automaticamente al
prossimo avvio (il precedente viene conservato come .bak).

Cosa fa, e perche' (la vecchia versione distruggeva il modello: ExpRate
su CROHME crollato dal 63% al 23%):

* Riparte SEMPRE dal checkpoint originale CoMER (--base), cosi' run
  successive non accumulano errori.
* Mescola ai tuoi esempi esempi del dataset CROHME (data.zip, "replay"):
  il modello impara la tua scrittura SENZA dimenticare tutto il resto.
* Congela le BatchNorm: con pochi esempi e batch piccoli le loro
  statistiche verrebbero rovinate (era la causa principale del crollo).
* Data augmentation (scala, rotazione, inclinazione, spessore) sui tuoi
  esempi: 200 immagini diventano molte varianti diverse.
* Valida su una parte degli esempi tenuta da parte e salva l'epoca
  migliore, misurando anche CROHME per accorgersi se il modello "dimentica".
* Le etichette vengono normalizzate (x^2 -> x ^ { 2 }, \\dots -> \\ldots,
  \\left( -> ( ...) e quelle non valide (typo, graffe sbilanciate)
  vengono SCARTATE e segnalate invece di sporcare il vocabolario.
* Il vocabolario viene salvato DENTRO il checkpoint: dictionary.txt non
  viene piu' modificato.

Su un laptop senza GPU il training richiede tempo (decine di minuti):
--threads controlla quanti core usare.

Python 3.7 compatibile.
"""
import argparse
import hashlib
import json
import math
import os
import random
import shutil
import sys
import time
import zipfile
from collections import Counter
from typing import Dict, List, Optional, Tuple

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from comer.latex_tokens import check_tokens, tokenize_latex  # noqa: E402
from comer import preprocess as P  # noqa: E402

DEFAULT_DATASET = os.path.join(HERE, "dataset")
DEFAULT_OUT = os.path.join(HERE, "finetuned_checkpoint.ckpt")
DATA_ZIP = os.path.join(HERE, "data.zip")


# ---------------------------------------------------------------------------
# Dataset utente
# ---------------------------------------------------------------------------

def load_user_examples(dataset_dir: str, base_words: List[str], verbose: bool = True):
    """Legge corrections.jsonl -> lista di (id, path immagine, tokens).

    Scarta (e segnala) esempi con immagine mancante o etichetta non valida.
    Se lo stesso id compare piu' volte vale l'ultima riga.
    """
    jsonl = os.path.join(dataset_dir, "corrections.jsonl")
    if not os.path.exists(jsonl):
        raise SystemExit("Non trovo %s: servono esempi salvati dal plugin." % jsonl)

    records = {}  # type: Dict[str, dict]
    with open(jsonl, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                print("  [scartato] riga %d: JSON non valido" % n)
                continue
            if "id" in r and "corrected" in r and "image_file" in r:
                records[r["id"]] = r

    known = set(base_words)
    examples = []
    rejected = 0
    for r in records.values():
        path = os.path.join(dataset_dir, r["image_file"])
        if not os.path.exists(path):
            print("  [scartato] %s: immagine mancante" % r["id"])
            rejected += 1
            continue
        toks = tokenize_latex(r["corrected"])
        ok, why = check_tokens(toks, known)
        if not ok:
            print("  [scartato] %s: %r -> %s" % (r["id"], r["corrected"], why))
            rejected += 1
            continue
        if len(toks) > 150:
            print("  [scartato] %s: formula troppo lunga (%d token)" % (r["id"], len(toks)))
            rejected += 1
            continue
        examples.append((r["id"], path, toks))
    examples.sort(key=lambda e: e[0])
    if verbose:
        print("Esempi validi: %d, scartati: %d" % (len(examples), rejected))
    return examples


def split_examples(examples, val_frac: float, seed: int):
    """Split deterministico (dipende solo dall'id): aggiungere esempi nuovi
    non sposta quelli vecchi da train a validazione."""
    if val_frac <= 0:
        return list(examples), []
    train, val = [], []
    for e in examples:
        h = int(hashlib.md5(("%d:%s" % (seed, e[0])).encode()).hexdigest()[:8], 16)
        (val if (h % 10000) / 10000.0 < val_frac else train).append(e)
    return train, val


# ---------------------------------------------------------------------------
# Augmentation
# ---------------------------------------------------------------------------

def augment(img: np.ndarray, rng: random.Random) -> np.ndarray:
    """Variazione casuale ma realistica di una formula (uint8, inchiostro chiaro).

    Scala, piccola rotazione, inclinazione (corsivo) e spessore del tratto.
    Il risultato ripassa per P.prepare (crop + margine) come all'inferenza.
    """
    import cv2

    h, w = img.shape
    s = rng.uniform(0.75, 1.3)
    angle = rng.uniform(-4.0, 4.0)
    shear = rng.uniform(-0.18, 0.18)
    # matrice: rotazione+scala attorno al centro, poi shear orizzontale
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, s)
    m = np.vstack([m, [0, 0, 1]])
    sh = np.array([[1, shear, -shear * h / 2.0], [0, 1, 0], [0, 0, 1]])
    m = (sh @ m)[:2]
    # tela abbastanza grande da non tagliare nulla
    corners = np.array([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1]], dtype=np.float64).T
    tc = m @ corners
    minx, miny = tc[0].min(), tc[1].min()
    m[0, 2] -= minx
    m[1, 2] -= miny
    nw = int(math.ceil(tc[0].max() - minx)) + 1
    nh = int(math.ceil(tc[1].max() - miny)) + 1
    out = cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_LINEAR, borderValue=0)
    r = rng.random()
    if r < 0.15:
        out = cv2.dilate(out, np.ones((2, 2), np.uint8))
    elif r < 0.25:
        out = cv2.erode(out, np.ones((2, 2), np.uint8))
    res = P.prepare(out)
    return res if res is not None else img


def scale_aug_crohme(img: np.ndarray, rng: random.Random) -> np.ndarray:
    """Stessa augmentation usata nel training originale di CoMER (0.7-1.4)
    + limiti di dimensione CROHME."""
    import cv2

    k = rng.uniform(0.7, 1.4)
    img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_LINEAR)
    h, w = img.shape
    r = min(1.0, P.MAX_H / float(h), P.MAX_W / float(w))
    if r < 1.0:
        img = cv2.resize(img, None, fx=r, fy=r, interpolation=cv2.INTER_LINEAR)
    if img.shape[0] < P.MIN_SIDE or img.shape[1] < P.MIN_SIDE:
        pad = np.zeros((max(img.shape[0], P.MIN_SIDE), max(img.shape[1], P.MIN_SIDE)), np.uint8)
        pad[: img.shape[0], : img.shape[1]] = img
        img = pad
    return img


# ---------------------------------------------------------------------------
# CROHME (replay)
# ---------------------------------------------------------------------------

class Crohme(object):
    """Accesso pigro alle immagini di data.zip."""

    def __init__(self, path: str, folder: str):
        self.zf = zipfile.ZipFile(path)
        lines = self.zf.read("data/%s/caption.txt" % folder).decode().splitlines()
        self.folder = folder
        self.items = []
        for line in lines:
            p = line.strip().split()
            if len(p) >= 2:
                self.items.append((p[0], p[1:]))

    def image(self, name: str) -> np.ndarray:
        import io
        from PIL import Image

        raw = self.zf.read("data/%s/img/%s.bmp" % (self.folder, name))
        return np.asarray(Image.open(io.BytesIO(raw)).convert("L")).copy()


# ---------------------------------------------------------------------------
# Modello
# ---------------------------------------------------------------------------

def build_model(base_ckpt_path: str, new_tokens: List[str]):
    """Carica il checkpoint base ed estende il vocabolario con new_tokens.

    I pesi dei token nuovi partono dalla media di quelli esistenti (meglio
    di valori casuali: il modello parte "neutro" invece che con preferenze
    arbitrarie).
    """
    import torch
    from comer.datamodule.vocab import vocab
    from comer.inference import checkpoint_words

    ckpt = torch.load(base_ckpt_path, map_location="cpu")
    base_words = checkpoint_words(ckpt)
    words = base_words + [t for t in new_tokens if t not in base_words]
    vocab.load_words(words)

    from comer.lit_comer import LitCoMER

    hparams = dict(ckpt["hyper_parameters"])
    model = LitCoMER(**hparams)
    new_state = model.state_dict()
    old_state = ckpt["state_dict"]
    n_old = len(base_words) + 3
    for name, t in new_state.items():
        old = old_state[name]
        if old.shape == t.shape:
            new_state[name] = old
            continue
        if name in ("comer_model.decoder.word_embed.0.weight",
                    "comer_model.decoder.proj.weight",
                    "comer_model.decoder.proj.bias"):
            t = t.clone()
            t[:n_old] = old
            if t.shape[0] > n_old:
                mean = old[3:].mean(dim=0)
                if t.dim() == 2:
                    std = old[3:].std(dim=0)
                    noise = torch.randn(t.shape[0] - n_old, t.shape[1]) * std * 0.1
                    t[n_old:] = mean + noise
                else:
                    t[n_old:] = mean
            new_state[name] = t
            continue
        raise RuntimeError("forma inattesa per %s: %s vs %s" % (name, old.shape, t.shape))
    model.load_state_dict(new_state, strict=True)
    return model, hparams, words, base_words


def freeze_batchnorm(model) -> None:
    import torch.nn as nn

    for m in model.modules():
        if isinstance(m, nn.modules.batchnorm._BatchNorm):
            m.eval()
            for p in m.parameters():
                p.requires_grad_(False)


def make_batch(items):
    """items: lista di (img uint8, indices) -> (imgs, mask, indices)."""
    import torch

    hs = [im.shape[0] for im, _ in items]
    ws = [im.shape[1] for im, _ in items]
    x = torch.zeros(len(items), 1, max(hs), max(ws))
    mask = torch.ones(len(items), max(hs), max(ws), dtype=torch.bool)
    for i, (im, _) in enumerate(items):
        x[i, 0, : im.shape[0], : im.shape[1]] = torch.from_numpy(im.astype(np.float32) / 255.0)
        mask[i, : im.shape[0], : im.shape[1]] = False
    return x, mask, [idx for _, idx in items]


def evaluate(model, samples, beam: int) -> Tuple[float, List[Tuple[str, List[str], List[str]]]]:
    """samples: lista di (nome, img, tokens). Ritorna (ExpRate, errori)."""
    from comer.inference import recognize

    model.eval()
    ok = 0
    errors = []
    for name, img, toks in samples:
        pred, _ = recognize(model, img, beam_size=beam)
        if pred == toks:
            ok += 1
        else:
            errors.append((name, pred, toks))
    return (ok / float(len(samples)) if samples else float("nan")), errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None) -> None:
    from comer.inference import ORIGINAL_CKPT

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=os.environ.get("PEN2LATEX_DATASET_DIR", DEFAULT_DATASET))
    ap.add_argument("--base", default=ORIGINAL_CKPT, help="checkpoint di partenza (default: originale CoMER)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--epochs", type=int, default=int(os.environ.get("FINETUNE_EPOCHS", "12")))
    ap.add_argument("--lr", type=float, default=float(os.environ.get("FINETUNE_LR", "1e-4")))
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--replay", type=float, default=1.0,
                    help="esempi CROHME per ogni esempio tuo, per epoca (0 = disattiva)")
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--all-data", action="store_true", help="nessuna validazione: allena su tutto")
    ap.add_argument("--crohme-val", type=int, default=150, help="campioni CROHME 2014 per controllare l'oblio")
    ap.add_argument("--beam", type=int, default=3, help="beam size durante la validazione")
    ap.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--check", action="store_true", help="controlla solo il dataset ed esci")
    args = ap.parse_args(argv)

    import torch

    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)

    from comer.inference import checkpoint_words

    base_ckpt = torch.load(args.base, map_location="cpu")
    base_words = checkpoint_words(base_ckpt)
    del base_ckpt

    print("== Dataset: %s" % args.dataset)
    examples = load_user_examples(args.dataset, base_words)
    counts = Counter(t for _, _, toks in examples for t in toks if t not in set(base_words))
    new_tokens = sorted(counts, key=lambda t: (-counts[t], t))
    if new_tokens:
        print("Simboli nuovi (occorrenze): " + ", ".join("%s(%d)" % (t, counts[t]) for t in new_tokens))
        rare = [t for t in new_tokens if counts[t] < 5]
        if rare:
            print("  ATTENZIONE: pochi esempi per %s -> scrivine altri (servono ~10+ per simbolo)" % ", ".join(rare))
    if args.check:
        return
    if len(examples) < 5:
        raise SystemExit("Troppi pochi esempi validi (%d)." % len(examples))

    train, val = split_examples(examples, 0.0 if args.all_data else args.val_frac, args.seed)
    print("Train: %d   Validazione: %d" % (len(train), len(val)))

    model, hparams, words, _ = build_model(args.base, new_tokens)
    from comer.datamodule.vocab import vocab
    from comer.utils.utils import ce_loss, to_bi_tgt_out

    print("Vocabolario: %d token (%d nuovi)" % (len(vocab), len(words) - len(base_words)))

    def load_user(e):
        img = P.prepare_bytes(open(e[1], "rb").read())
        if img is None:
            return None
        return (e[0], img, e[2])

    train_s = [s for s in (load_user(e) for e in train) if s is not None]
    val_s = [s for s in (load_user(e) for e in val) if s is not None]

    crohme_train = crohme_val = None
    if os.path.exists(DATA_ZIP):
        if args.replay > 0:
            crohme_train = Crohme(DATA_ZIP, "train")
        if args.crohme_val > 0:
            cv = Crohme(DATA_ZIP, "2014")
            pick = random.Random(0).sample(cv.items, min(args.crohme_val, len(cv.items)))
            crohme_val = [(n, cv.image(n), t) for n, t in pick]
    else:
        print("ATTENZIONE: %s non trovato -> niente replay CROHME (rischio di 'dimenticare')." % DATA_ZIP)

    # ---- valutazione di partenza (stesso modello, vocabolario esteso) ----
    t0 = time.time()
    base_user = evaluate(model, val_s, args.beam)[0] if val_s else float("nan")
    base_crohme = evaluate(model, crohme_val, args.beam)[0] if crohme_val else float("nan")
    print("Prima del fine-tuning: validazione tua=%.3f  CROHME=%.3f  (%.0fs)"
          % (base_user, base_crohme, time.time() - t0))

    # ---- ottimizzatore: warmup + coseno ----
    freeze_batchnorm(model)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.Adam(params, lr=args.lr)
    n_replay = int(round(len(train_s) * args.replay)) if crohme_train else 0
    steps_per_epoch = int(math.ceil((len(train_s) + n_replay) / float(args.batch_size)))
    total = steps_per_epoch * args.epochs
    warm = max(1, steps_per_epoch // 2)

    def lr_at(step):
        if step < warm:
            return args.lr * (step + 1) / float(warm)
        prog = (step - warm) / float(max(1, total - warm))
        return args.lr * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * prog)))

    best = None  # (score, epoch, state)
    step = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        freeze_batchnorm(model)
        items = [(augment(img, rng), vocab.words2indices(t)) for _, img, t in train_s]
        if n_replay:
            for name, toks in rng.sample(crohme_train.items, n_replay):
                if any(t not in vocab.word2idx for t in toks):
                    continue
                items.append((scale_aug_crohme(crohme_train.image(name), rng), vocab.words2indices(toks)))
        rng.shuffle(items)
        # batch di immagini di taglia simile = meno padding = piu' veloce
        chunks = [items[i: i + args.batch_size * 8] for i in range(0, len(items), args.batch_size * 8)]
        batches = []
        for ch in chunks:
            ch.sort(key=lambda it: it[0].shape[0] * it[0].shape[1])
            batches += [ch[i: i + args.batch_size] for i in range(0, len(ch), args.batch_size)]
        rng.shuffle(batches)

        t0 = time.time()
        losses = []
        for b in batches:
            for g in opt.param_groups:
                g["lr"] = lr_at(step)
            x, mask, idx = make_batch(b)
            tgt, out = to_bi_tgt_out(idx, torch.device("cpu"))
            loss = ce_loss(model(x, mask, tgt), out)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            losses.append(loss.item())
            step += 1
        train_time = time.time() - t0

        msg = "epoca %2d/%d  loss=%.4f  (%.0fs)" % (epoch, args.epochs, float(np.mean(losses)), train_time)
        if val_s or crohme_val:
            u = evaluate(model, val_s, args.beam)[0] if val_s else float("nan")
            c = evaluate(model, crohme_val, args.beam)[0] if crohme_val else float("nan")
            msg += "  validazione tua=%.3f  CROHME=%.3f" % (u, c)
            # punteggio: prima la tua scrittura, CROHME come spareggio
            score = u + 0.25 * (0.0 if math.isnan(c) else c)
            if val_s and (best is None or score > best[0]):
                best = (score, epoch, {k: v.detach().clone() for k, v in model.state_dict().items()})
                msg += "  *"
        print(msg, flush=True)

    if best is not None and val_s:
        print("Epoca migliore: %d" % best[1])
        model.load_state_dict(best[2])
    model.eval()

    if val_s:
        acc, errors = evaluate(model, val_s, args.beam)
        print("\nValidazione finale (tua scrittura): %.3f  (prima: %.3f)" % (acc, base_user))
        for name, pred, toks in errors[:15]:
            print("  %s\n     atteso:   %s\n     predetto: %s" % (name, " ".join(toks), " ".join(pred)))

    # ---- salvataggio atomico, con backup del precedente ----
    meta = {
        "base": os.path.basename(args.base),
        "examples": len(examples),
        "train": len(train_s),
        "val": len(val_s),
        "epochs": args.epochs,
        "best_epoch": best[1] if best else args.epochs,
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    tmp = args.out + ".tmp"
    torch.save({"state_dict": model.state_dict(), "hyper_parameters": hparams,
                "vocab": words, "pen2latex_meta": meta}, tmp)
    if os.path.exists(args.out):
        shutil.copyfile(args.out, args.out + ".bak")
    os.replace(tmp, args.out)
    print("\nSalvato: %s  (il precedente e' in %s.bak)" % (args.out, os.path.basename(args.out)))
    print("Riavvia il backend per usarlo.")


if __name__ == "__main__":
    main()
