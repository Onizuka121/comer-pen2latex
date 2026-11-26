"""Image preprocessing shared by the backend (inference) and fine-tuning.

The model receives a binary-ish image with WHITE ink on BLACK background,
cropped around the ink with a margin -- the format of the CROHME images it
was trained on.

The parameters below were chosen by measuring recognition accuracy on the
user's corrected examples (dataset/corrections.jsonl), not by guessing:
re-normalising symbol size or stroke thickness to CROHME statistics made
results WORSE, so they are deliberately not done.  See docs/ANALYSIS.md.

Everything that reaches the model goes through :func:`prepare`, so the
images used for fine-tuning are processed exactly like the ones at
inference time.

Python 3.7 compatible.
"""
import base64
import io
from typing import Optional

import numpy as np
from PIL import Image

# Ink/background threshold on the 0..255 scale (bright ink).
BINARIZE_THRESHOLD = 100
# Empty margin around the formula after cropping (pixels).
CROP_PADDING = 20
# Size limits of the image fed to the model: the CROHME training range.
# Bigger images are scaled down (keeping the aspect ratio).
MAX_H = 256
MAX_W = 1024
MIN_SIDE = 16
# Connected components smaller than this (pixels) are noise, not ink.
MIN_SPECK_AREA = 3


def decode_data_url(data: str) -> bytes:
    """'data:image/png;base64,AAAA' or bare base64 -> raw bytes."""
    if "," in data:
        data = data.split(",", 1)[1]
    return base64.b64decode(data)


def load_ink_image(raw: bytes) -> np.ndarray:
    """Decode any image into uint8 grayscale with BRIGHT ink on DARK bg.

    Transparent pixels are background.  Polarity is decided from the image
    border (the background touches the border, the formula normally does
    not), which is more robust than the global mean when writing is dense.
    """
    img = Image.open(io.BytesIO(raw))
    img.load()
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = np.asarray(img.convert("RGBA")).astype(np.float32)
        gray = 0.299 * rgba[..., 0] + 0.587 * rgba[..., 1] + 0.114 * rgba[..., 2]
        alpha = rgba[..., 3] / 255.0
        opaque = alpha > 0.5
        light_bg = _background_is_light(gray, opaque)
        bg_value = 255.0 if light_bg else 0.0
        arr = np.clip(gray * alpha + bg_value * (1.0 - alpha), 0, 255).astype(np.uint8)
    else:
        arr = np.asarray(img.convert("L")).copy()
        light_bg = _background_is_light(arr.astype(np.float32), None)
    if light_bg:
        arr = 255 - arr
    return arr


def _background_is_light(gray: np.ndarray, valid: Optional[np.ndarray]) -> bool:
    border = np.concatenate([gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]])
    if valid is not None:
        vb = np.concatenate([valid[0, :], valid[-1, :], valid[:, 0], valid[:, -1]])
        if vb.any():
            border = border[vb]
        elif valid.any():
            border = gray[valid]
        else:
            return False  # fully transparent: treat as dark background
    return float(np.median(border)) > 127


def _remove_specks(mask: np.ndarray) -> np.ndarray:
    import cv2

    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if n <= 1:
        return mask
    keep = np.zeros(n, dtype=bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= MIN_SPECK_AREA
    return keep[lab]


def prepare(arr: np.ndarray) -> Optional[np.ndarray]:
    """Bright-ink uint8 image -> model input (uint8 HxW), or None if blank.

    1. binarise (threshold 100)
    2. drop isolated specks
    3. crop around the ink with CROP_PADDING margin (black)
    4. scale down only if larger than the CROHME range
    """
    mask = arr > BINARIZE_THRESHOLD
    mask = _remove_specks(mask)
    if not mask.any():
        return None
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    mask = mask[rows[0]: rows[-1] + 1, cols[0]: cols[-1] + 1]

    h, w = mask.shape
    p = CROP_PADDING
    out = np.zeros((h + 2 * p, w + 2 * p), dtype=np.uint8)
    out[p: p + h, p: p + w] = mask.astype(np.uint8) * 255

    oh, ow = out.shape
    scale = min(1.0, MAX_H / float(oh), MAX_W / float(ow))
    if scale < 1.0:
        new_size = (max(1, int(ow * scale)), max(1, int(oh * scale)))
        out = np.asarray(Image.fromarray(out).resize(new_size, Image.LANCZOS))

    if out.shape[0] < MIN_SIDE or out.shape[1] < MIN_SIDE:
        padded = np.zeros((max(out.shape[0], MIN_SIDE), max(out.shape[1], MIN_SIDE)), np.uint8)
        padded[: out.shape[0], : out.shape[1]] = out
        out = padded
    return out


def prepare_bytes(raw: bytes) -> Optional[np.ndarray]:
    return prepare(load_ink_image(raw))


def to_tensor_input(img: np.ndarray):
    """uint8 HxW -> (FloatTensor [1,1,H,W] in 0..1, BoolTensor mask [1,H,W])."""
    import torch

    t = torch.from_numpy(img.astype(np.float32) / 255.0)[None, None]
    mask = torch.zeros((1, img.shape[0], img.shape[1]), dtype=torch.bool)
    return t, mask
