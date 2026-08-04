"""
Debug del preprocessing: applica ogni step di decode_image() separatamente
e salva il risultato intermedio come PNG, cosi' vediamo dove si rompe.

Uso (dalla cartella ~/comer-project/CoMER, con l'env conda 'comer' attivo):
    python debug_preprocess.py example/UN19_1041_em_595.bmp
"""
import sys
import numpy as np
from PIL import Image, ImageOps

BINARIZE_THRESHOLD = 200
CROP_PADDING = 20
MAX_DIMENSION = 400

path = sys.argv[1] if len(sys.argv) > 1 else "example/UN19_1041_em_595.bmp"

img = Image.open(path)
print(f"0. Originale: mode={img.mode}, size={img.size}")
img.convert("RGB").save("debug_0_originale.png")

# Step 1: alpha handling
if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
    img = img.convert("RGBA")
    background = Image.new("RGBA", img.size, (255, 255, 255, 255))
    img = Image.alpha_composite(background, img)
    print("1. Alpha compositato su bianco")
else:
    print("1. Nessun alpha da gestire")

img = img.convert("L")
img.save("debug_1_grayscale.png")

# Step 2: polarita'
arr = np.array(img)
mean_brightness = arr.mean()
print(f"2. Luminosita' media: {mean_brightness:.1f}")
if mean_brightness < 127:
    print("   -> Inverto (sfondo scuro rilevato)")
    img = ImageOps.invert(img)
    arr = np.array(img)
else:
    print("   -> Nessuna inversione")
img.save("debug_2_polarita.png")

# Step 3: binarizzazione
arr_bin = np.where(arr < BINARIZE_THRESHOLD, 0, 255).astype(np.uint8)
Image.fromarray(arr_bin, mode="L").save("debug_3_binarizzata.png")
print(f"3. Binarizzata (soglia {BINARIZE_THRESHOLD}). "
      f"Pixel neri (inchiostro): {(arr_bin < 128).sum()} su {arr_bin.size}")

# Step 4: crop
ink_rows, ink_cols = np.where(arr_bin < 128)
if len(ink_rows) > 0:
    top, bottom = ink_rows.min(), ink_rows.max()
    left, right = ink_cols.min(), ink_cols.max()
    top = max(0, top - CROP_PADDING)
    left = max(0, left - CROP_PADDING)
    bottom = min(arr_bin.shape[0], bottom + CROP_PADDING)
    right = min(arr_bin.shape[1], right + CROP_PADDING)
    arr_crop = arr_bin[top:bottom, left:right]
    print(f"4. Crop: bbox originale righe[{top}:{bottom}] colonne[{left}:{right}], "
          f"nuova size={arr_crop.shape[::-1]}")
else:
    arr_crop = arr_bin
    print("4. ATTENZIONE: nessun inchiostro rilevato, nessun crop applicato")
img_crop = Image.fromarray(arr_crop, mode="L")
img_crop.save("debug_4_crop.png")

# Step 5: resize
w, h = img_crop.size
longest_side = max(w, h)
if longest_side > MAX_DIMENSION:
    scale = MAX_DIMENSION / longest_side
    new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
    img_final = img_crop.resize(new_size, Image.LANCZOS)
    print(f"5. Resize da {img_crop.size} a {new_size}")
else:
    img_final = img_crop
    print(f"5. Nessun resize necessario (size={img_crop.size}, max consentito={MAX_DIMENSION})")
img_final.save("debug_5_finale.png")

print("\nFatto. Guarda i file debug_0...5_*.png per vedere dove si rompe.")
print(f"Dimensione finale passata al modello: {img_final.size}")