"""
Misura quanto bene un checkpoint riconosce la TUA scrittura.

    python evaluate.py                              # checkpoint usato dal backend
    python evaluate.py --ckpt finetuned_checkpoint.ckpt --split val
    python evaluate.py --ckpt original --crohme 300

--split val  usa solo gli esempi di validazione di finetuning.py (mai visti
             in training: e' la misura onesta per un modello fine-tunato)
--split all  usa tutti gli esempi del dataset

ExpRate = percentuale di formule riconosciute in modo ESATTAMENTE corretto.
Python 3.7 compatibile.
"""
import argparse
import os
import random
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def main(argv=None):
    from comer.inference import ORIGINAL_CKPT

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", default=None, help="checkpoint ('original' = CoMER originale)")
    ap.add_argument("--dataset", default=os.path.join(HERE, "dataset"))
    ap.add_argument("--split", choices=["val", "all"], default="val")
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--crohme", type=int, default=0, help="valuta anche N formule di CROHME 2014")
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--show", type=int, default=20, help="quanti errori mostrare")
    args = ap.parse_args(argv)

    if args.ckpt in (None, ""):
        ft = os.path.join(HERE, "finetuned_checkpoint.ckpt")
        args.ckpt = ft if os.path.exists(ft) else ORIGINAL_CKPT
    elif args.ckpt == "original":
        args.ckpt = ORIGINAL_CKPT

    import finetuning as F
    from comer import preprocess as P
    from comer.datamodule.vocab import vocab
    from comer.inference import load_model, recognize

    print("Checkpoint: %s" % args.ckpt)
    model = load_model(args.ckpt, threads=args.threads)
    known = set(vocab.word2idx)

    examples = F.load_user_examples(args.dataset, vocab.words, verbose=False)
    if args.split == "val":
        _, examples = F.split_examples(examples, args.val_frac, args.seed)
    print("Esempi: %d (%s)" % (len(examples), args.split))

    ok = reachable = ok_reach = 0
    errors = []
    t0 = time.time()
    for ex_id, path, toks in examples:
        img = P.prepare_bytes(open(path, "rb").read())
        pred = recognize(model, img, beam_size=args.beam)[0] if img is not None else []
        good = pred == toks
        ok += good
        if all(t in known for t in toks):
            reachable += 1
            ok_reach += good
        if not good:
            errors.append((ex_id, toks, pred))
    n = max(1, len(examples))
    print("\nLa tua scrittura: ExpRate %.1f%%  (%d/%d)   %.2fs/formula"
          % (100.0 * ok / n, ok, len(examples), (time.time() - t0) / n))
    if reachable < len(examples):
        print("  solo formule con simboli noti al modello: %.1f%% (%d/%d)"
              % (100.0 * ok_reach / max(1, reachable), ok_reach, reachable))
    for ex_id, toks, pred in errors[: args.show]:
        print("  %s\n     atteso:   %s\n     predetto: %s" % (ex_id, " ".join(toks), " ".join(pred)))

    if args.crohme > 0:
        zpath = os.path.join(HERE, "data.zip")
        cr = F.Crohme(zpath, "2014")
        pick = random.Random(0).sample(cr.items, min(args.crohme, len(cr.items)))
        good = sum(recognize(model, cr.image(name), beam_size=args.beam)[0] == toks for name, toks in pick)
        print("\nCROHME 2014: ExpRate %.1f%%  (%d/%d)" % (100.0 * good / len(pick), good, len(pick)))


if __name__ == "__main__":
    main()
