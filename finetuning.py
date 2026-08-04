"""
Fine-tuning di CoMER sugli esempi raccolti dal plugin Obsidian
(dataset/corrections.jsonl + dataset/images/*.png).

ATTENZIONE: con pochissimi esempi (es. 4) questo NON produce un modello
generalizzato sui nuovi simboli -- serve a verificare che l'intera pipeline
(estensione vocabolario, resize dei pesi, training loop) funzioni
correttamente end-to-end. Servono verosimilmente decine di esempi PER
SIMBOLO NUOVO prima di vedere un miglioramento reale e affidabile.

Uso (dalla cartella ~/comer-project/CoMER, con l'env conda 'comer' attivo,
e con backend_comer.py presente nella stessa cartella):

    python finetune.py

Produce: finetuned_checkpoint.ckpt (nella cartella corrente).
Per usarlo nel backend:
    COMER_CKPT=$(pwd)/finetuned_checkpoint.ckpt python backend_comer.py

Nota: ogni esecuzione riparte SEMPRE dal checkpoint originale pre-addestrato
(CKPT_IN sotto), non da un eventuale finetuned_checkpoint.ckpt precedente.
Scelta deliberata per evitare di accumulare overfitting su pochi dati in
run successive. Se in futuro il dataset cresce molto e si vuole fare
fine-tuning incrementale, cambiare CKPT_IN per puntare all'ultimo
checkpoint fine-tuned.
"""
import base64
import json
import os
import sys

import torch
import torch.optim as optim
from torchvision.transforms import ToTensor

DATASET_DIR = os.environ.get("PEN2LATEX_DATASET_DIR", "dataset")
DICT_PATH = "comer/datamodule/dictionary.txt"
CKPT_IN = (
    "lightning_logs/version_0/checkpoints/"
    "epoch=151-step=57151-val_ExpRate=0.6365.ckpt"
)
CKPT_OUT = "finetuned_checkpoint.ckpt"
EPOCHS = int(os.environ.get("FINETUNE_EPOCHS", "30"))
LR = float(os.environ.get("FINETUNE_LR", "1e-4"))


def tokenize_latex(latex: str):
    """Spezza una stringa LaTeX nello stesso stile di token del dizionario
    CoMER: i comandi (\\ln, \\cap, \\sum, ...) restano interi, tutto il
    resto (lettere, cifre, parentesi, ^ _ operatori) e' un token per
    carattere."""
    tokens = []
    i = 0
    while i < len(latex):
        c = latex[i]
        if c.isspace():
            i += 1
            continue
        if c == "\\":
            j = i + 1
            while j < len(latex) and latex[j].isalpha():
                j += 1
            tokens.append(latex[i:j])
            i = j
        else:
            tokens.append(c)
            i += 1
    return tokens


def main():
    jsonl_path = os.path.join(DATASET_DIR, "corrections.jsonl")
    if not os.path.exists(jsonl_path):
        print(f"Non trovo {jsonl_path}. Serve almeno un esempio salvato dal plugin.")
        sys.exit(1)

    examples = []
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))

    print(f"Trovati {len(examples)} esempi in {jsonl_path}")
    if len(examples) < 10:
        print(
            "Pochi esempi: questo e' un test della pipeline, non "
            "aspettarti un vero miglioramento di accuratezza."
        )

    # --- 1. Tokenizza tutte le formule ed estendi il dizionario se serve ---
    with open(DICT_PATH, encoding="utf-8") as f:
        existing_tokens = [line.strip() for line in f if line.strip()]
    existing_set = set(existing_tokens)

    tokenized_examples = []
    new_tokens = []
    for ex in examples:
        toks = tokenize_latex(ex["corrected"])
        tokenized_examples.append((ex, toks))
        for t in toks:
            if t not in existing_set and t not in new_tokens:
                new_tokens.append(t)

    if new_tokens:
        print(f"Nuovi simboli trovati, li aggiungo al dizionario: {new_tokens}")
        with open(DICT_PATH, "a", encoding="utf-8") as f:
            for t in new_tokens:
                f.write(t + "\n")
    else:
        print("Nessun simbolo nuovo, il dizionario resta invariato.")

    # IMPORTANTE: importiamo i moduli comer SOLO ORA, dopo aver esteso il
    # dizionario su disco, cosi' vocab_size viene calcolato gia' con la
    # dimensione giusta e i layer del modello nascono della taglia corretta.
    from comer.datamodule import vocab, vocab_size
    from comer.datamodule.datamodule import Batch
    from comer.lit_comer import LitCoMER
    from comer.utils.utils import ce_loss, to_bi_tgt_out

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from backend import \
        decode_image  # riusa lo stesso preprocessing dell'inferenza

    print(f"Vocabolario finale: {vocab_size} simboli")

    # --- 2. Carica il vecchio checkpoint e costruisci il modello nuovo ---
    old_ckpt = torch.load(CKPT_IN, map_location="cpu")
    hparams = old_ckpt["hyper_parameters"]
    old_state = old_ckpt["state_dict"]

    model = LitCoMER(**hparams)
    new_state = model.state_dict()

    vocab_dependent = {
        "comer_model.decoder.word_embed.0.weight",
        "comer_model.decoder.proj.weight",
        "comer_model.decoder.proj.bias",
    }

    copied, resized, skipped = [], [], []
    for name, new_tensor in new_state.items():
        if name not in old_state:
            skipped.append(name)
            continue
        old_tensor = old_state[name]
        if old_tensor.shape == new_tensor.shape:
            new_state[name] = old_tensor
            copied.append(name)
        elif name in vocab_dependent:
            # copia i pesi dei simboli vecchi, lascia l'inizializzazione
            # casuale (gia' presente in new_tensor) per i simboli nuovi
            n_old = old_tensor.shape[0]
            with torch.no_grad():
                new_tensor[:n_old] = old_tensor
            new_state[name] = new_tensor
            resized.append(name)
        else:
            skipped.append(name)

    model.load_state_dict(new_state)
    print(
        f"Pesi copiati identici: {len(copied)}, "
        f"ridimensionati (nuovi simboli): {resized}, "
        f"saltati (dovrebbe essere vuoto): {skipped}"
    )

    model.train()

    # --- 3. Prepara tutti gli esempi (immagine gia' preprocessata + indici) ---
    prepared = []
    for ex, toks in tokenized_examples:
        img_path = os.path.join(DATASET_DIR, ex["image_file"])
        with open(img_path, "rb") as f:
            raw_bytes = f.read()
        b64 = base64.b64encode(raw_bytes).decode()
        img = decode_image(f"data:image/png;base64,{b64}")
        tensor = ToTensor()(img)
        indices = vocab.words2indices(toks)
        prepared.append((ex["id"], tensor, indices))
        print(f"  {ex['id']}: {' '.join(toks)}")

    # --- 4. Training loop a mini-batch, per non esplodere in RAM/CPU ---
    # MINI_BATCH_SIZE piccolo (default 1) tiene i tensori padded piccoli:
    # l'immagine piu' grande di un gruppo piccolo e' quasi sempre molto
    # piu' contenuta di quella dell'intero dataset messo insieme.
    MINI_BATCH_SIZE = int(os.environ.get("FINETUNE_BATCH_SIZE", "1"))

    optimizer = optim.Adam(model.parameters(), lr=LR)

    def make_batch(group):
        """Costruisce un Batch (con padding) da un piccolo gruppo di esempi."""
        ids = [g[0] for g in group]
        tensors = [g[1] for g in group]
        indices_list = [g[2] for g in group]

        heights = [t.shape[1] for t in tensors]
        widths = [t.shape[2] for t in tensors]
        max_h, max_w = max(heights), max(widths)
        n = len(tensors)

        x = torch.zeros(n, 1, max_h, max_w)
        x_mask = torch.ones(n, max_h, max_w, dtype=torch.bool)
        for idx, t in enumerate(tensors):
            h, w = t.shape[1], t.shape[2]
            x[idx, :, :h, :w] = t
            x_mask[idx, :h, :w] = False

        return Batch(img_bases=ids, imgs=x, mask=x_mask, indices=indices_list)

    print(f"\nTraining a mini-batch di {MINI_BATCH_SIZE} esempio/i per volta, "
          f"{EPOCHS} epoche...")

    for epoch in range(EPOCHS):
        epoch_losses = []
        for i in range(0, len(prepared), MINI_BATCH_SIZE):
            group = prepared[i : i + MINI_BATCH_SIZE]
            batch = make_batch(group)

            optimizer.zero_grad()
            tgt, out = to_bi_tgt_out(batch.indices, torch.device("cpu"))
            out_hat = model(batch.imgs, batch.mask, tgt)
            loss = ce_loss(out_hat, out)
            loss.backward()
            optimizer.step()
            epoch_losses.append(loss.item())

        avg_loss = sum(epoch_losses) / len(epoch_losses)
        if epoch % 5 == 0 or epoch == EPOCHS - 1:
            print(f"epoch {epoch:3d}  loss medio={avg_loss:.4f}")

    # --- 5. Salva il nuovo checkpoint ---
    torch.save(
        {"state_dict": model.state_dict(), "hyper_parameters": hparams},
        CKPT_OUT,
    )
    print(f"\nSalvato: {CKPT_OUT}")
    print(f"Per usarlo nel backend: COMER_CKPT={os.path.abspath(CKPT_OUT)} python backend_comer.py")



if __name__ == "__main__":
    main()
