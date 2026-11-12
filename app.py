"""
Razorpay dynamic QR -> 1-bit bitmap converter for the ESP32 HMI display.

Two consumers:
  * the ESP32 firmware  -> POST /convert  (image_url=...)   returns byte_array
  * a person in a browser -> GET /          tuning console (crop, scale, threshold)
"""
import base64
import io
import razorpay
import logging
import os
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv, set_key
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"

# Flask looks for templates/ and static/ next to this file, regardless of the
# directory `python app.py` was started from.
app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)
CORS(app)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
# Display geometry used by src.ino (QR panel is 230 x 262 px on a 480 x 272 screen)
DISPLAY_QR_MAX_W = 220
DISPLAY_QR_MAX_H = 250
# JSON buffer on the ESP32 (DynamicJsonDocument doc(16384)); every byte costs 6 chars "0xFF, "
ESP_JSON_BUDGET = 16384


# --------------------------------------------------------------------------- settings
def _env():
    load_dotenv(ENV_PATH, override=True)


def _as_bool(value, default):
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def load_settings():
    """Device defaults, stored in .env so the ESP32 gets them without sending anything."""
    _env()
    return {
        "crop": {
            "top": int(os.getenv("CROP_TOP", 0)),
            "right": int(os.getenv("CROP_RIGHT", 0)),
            "bottom": int(os.getenv("CROP_BOTTOM", 0)),
            "left": int(os.getenv("CROP_LEFT", 0)),
        },
        "compression": int(os.getenv("COMPRESSION_FACTOR", 100)),
        "threshold": int(os.getenv("THRESHOLD", 128)),
        "mode": os.getenv("MODE", "horizontal"),
        "invert": _as_bool(os.getenv("INVERT"), True),
    }


def get_razorpay_client():
    _env()

    key_id = os.getenv("RAZORPAY_KEY_ID")
    key_secret = os.getenv("RAZORPAY_KEY_SECRET")

    if not key_id or not key_secret:
        raise ValueError("Razorpay credentials are missing")

    return razorpay.Client(auth=(key_id, key_secret))


def save_settings(settings):
    ENV_PATH.touch(exist_ok=True)
    path = str(ENV_PATH)
    for side, value in settings["crop"].items():
        set_key(path, f"CROP_{side.upper()}", str(int(value)))
    set_key(path, "COMPRESSION_FACTOR", str(int(settings["compression"])))
    set_key(path, "THRESHOLD", str(int(settings["threshold"])))
    set_key(path, "MODE", settings["mode"])
    set_key(path, "INVERT", "true" if settings["invert"] else "false")


def clamp(value, low, high):
    return max(low, min(high, value))


def parse_settings(source, defaults):
    """Read tuning values from a form/JSON mapping, falling back to saved defaults."""
    get = source.get

    def num(key, fallback):
        try:
            return int(float(get(key, fallback)))
        except (TypeError, ValueError):
            return fallback

    crop = {
        side: max(0, num(f"crop_{side}", defaults["crop"][side]))
        for side in ("top", "right", "bottom", "left")
    }
    mode = get("mode", defaults["mode"])
    return {
        "crop": crop,
        "compression": clamp(num("compression", defaults["compression"]), 10, 100),
        "threshold": clamp(num("threshold", defaults["threshold"]), 0, 255),
        "mode": mode if mode in ("horizontal", "vertical") else "horizontal",
        "invert": _as_bool(get("invert"), defaults["invert"]),
    }


# --------------------------------------------------------------------------- imaging
def apply_crop(image, crop):
    width, height = image.size
    left, top = crop["left"], crop["top"]
    right, bottom = width - crop["right"], height - crop["bottom"]
    if right - left < 8 or bottom - top < 8:
        raise ValueError(
            f"Crop leaves nothing to convert ({right - left}x{bottom - top}px). "
            f"The source is {width}x{height}px; reduce the crop values."
        )
    return image.crop((left, top, right, bottom))


def compress_image(image, factor):
    if factor >= 100:
        return image
    width = max(1, int(image.width * factor / 100))
    height = max(1, int(image.height * factor / 100))
    return image.resize((width, height), Image.LANCZOS)


def image_to_byte_array(image, threshold=128, mode="horizontal", invert=True):
    """
    Pack the image into bits, row after row, MSB first.

    invert=True  -> bit 1 = dark pixel. This is what src.ino expects
                    (`is_black = bit set`), so leave it on for the device.
    invert=False -> bit 1 = light pixel.
    """
    gray = image.convert("L")
    if mode == "vertical":
        gray = gray.transpose(Image.TRANSPOSE)
    width, height = gray.size
    pixels = gray.tobytes()

    out = bytearray()
    byte = 0
    bit_count = 0
    for value in pixels:
        light = value > threshold
        bit = (not light) if invert else light
        if bit:
            byte |= 1 << (7 - bit_count)
        bit_count += 1
        if bit_count == 8:
            out.append(byte)
            byte = 0
            bit_count = 0
    if bit_count:
        out.append(byte)
    return bytes(out), width, height


def bytes_to_preview(data, width, height, invert=True):
    """Render the packed bytes back into a PNG: exactly what the display will draw."""
    img = Image.new("L", (width, height), 255)
    px = img.load()
    for i in range(width * height):
        bit = (data[i // 8] >> (7 - (i % 8))) & 1
        dark = bit if invert else not bit
        px[i % width, i // width] = 0 if dark else 255
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def fetch_remote_image(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Image URL must start with http:// or https://")
    resp = requests.get(url, timeout=10, stream=True)
    resp.raise_for_status()
    content = resp.raw.read(MAX_DOWNLOAD_BYTES + 1, decode_content=True)
    if len(content) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Remote image is larger than 5 MB")
    return Image.open(io.BytesIO(content))


# --------------------------------------------------------------------------- routes
@app.route("/")
def index():
    return render_template(
        "index.html",
        settings=load_settings(),
        limits={
            "max_w": DISPLAY_QR_MAX_W,
            "max_h": DISPLAY_QR_MAX_H,
            "json_budget": ESP_JSON_BUDGET,
        },
    )


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/settings", methods=["GET"])
def get_settings():
    return jsonify(load_settings())


@app.route("/settings", methods=["POST"])
def post_settings():
    payload = request.get_json(silent=True) or {}
    flat = {f"crop_{k}": v for k, v in (payload.get("crop") or {}).items()}
    flat.update({k: v for k, v in payload.items() if k != "crop"})
    settings = parse_settings(flat, load_settings())
    save_settings(settings)
    logging.info("Saved device defaults: %s", settings)
    return jsonify({"status": "success", "settings": settings})


@app.route("/save_crop", methods=["POST"])
def save_crop():
    """Kept for backwards compatibility with the original API."""
    payload = request.get_json(silent=True) or {}
    current = load_settings()
    current["crop"].update({k: int(v) for k, v in payload.items() if k in current["crop"]})
    save_settings(current)
    return jsonify({"status": "success", "crop_settings": current["crop"]})


@app.route("/convert", methods=["POST"])
def convert_image():
    """
    Form fields:
      image | image_url      the source (required)
      threshold, mode, invert, compression, crop_top/right/bottom/left
                             optional overrides; saved defaults are used when absent
      preview=1              also return the 1-bit preview PNG (the ESP32 does not ask
                             for this, which keeps its response small)
    """
    settings = parse_settings(request.form, load_settings())

    try:
        if "image" in request.files:
            source = Image.open(request.files["image"].stream)
        elif request.form.get("image_url"):
            source = fetch_remote_image(request.form["image_url"])
        else:
            return jsonify({"error": "Provide an image file or an image_url."}), 400

        # Flatten transparency onto white so transparent QR backgrounds don't turn black.
        if source.mode in ("RGBA", "LA", "P"):
            source = source.convert("RGBA")
            backdrop = Image.new("RGBA", source.size, (255, 255, 255, 255))
            source = Image.alpha_composite(backdrop, source)
        source = source.convert("L")
        original_size = source.size

        image = apply_crop(source, settings["crop"])

        # Apply the user's preferred scale first.
        image = compress_image(image, settings["compression"])

        # Automatically fit within the display and ESP32 JSON buffer.
                        # Automatically fit within display and buffer limits.
        SAFE_JSON_BUDGET = int(ESP_JSON_BUDGET * 0.80)

        max_pixels = min(
            DISPLAY_QR_MAX_W * DISPLAY_QR_MAX_H,
            (SAFE_JSON_BUDGET // 6) * 8
        )

        scale = min(
            1.0,
            DISPLAY_QR_MAX_W / image.width,
            DISPLAY_QR_MAX_H / image.height,
            (max_pixels / (image.width * image.height)) ** 0.5
        )

        if scale < 1.0:
            new_w = max(8, int(image.width * scale))
            new_h = max(1, int(image.height * scale))

            # Keep width divisible by 8.
            new_w = max(8, (new_w // 8) * 8)

            image = image.resize((new_w, new_h), Image.LANCZOS)

        # Verify the final output fits all limits.
        while (
            image.width > DISPLAY_QR_MAX_W
            or image.height > DISPLAY_QR_MAX_H
            or ((image.width * image.height + 7) // 8) * 6 > SAFE_JSON_BUDGET
        ):
            new_w = max(8, ((image.width - 8) // 8) * 8)
            new_h = max(1, int(image.height * new_w / image.width))
            image = image.resize((new_w, new_h), Image.LANCZOS)

        data, out_w, out_h = image_to_byte_array(image, settings["threshold"], settings["mode"], settings["invert"])
        formatted = ", ".join(f"0x{b:02X}" for b in data)

        result = {
            "byte_array": formatted,
            "width": out_w,
            "height": out_h,
            "byte_count": len(data),
            "json_bytes": len(formatted),
            "original_width": original_size[0],
            "original_height": original_size[1],
            "settings": settings,
        }
        if request.form.get("preview") == "1":
            result["preview_image"] = bytes_to_preview(data, out_w, out_h, settings["invert"])
        return jsonify(result)

    except (ValueError, requests.RequestException) as exc:
        logging.warning("convert failed: %s", exc)
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # unreadable image, etc.
        logging.exception("convert failed")
        return jsonify({"error": f"Could not process the image: {exc}"}), 500


@app.route("/create_qr", methods=["POST"])
def create_qr():
    try:
        payload = request.get_json(silent=True) or {}
        amount = float(payload.get("amount", 0))

        if not 1 <= amount <= 100000:
            return jsonify({"error": "Enter a valid amount"}), 400

        amount_paise = round(amount * 100)
        client = get_razorpay_client()

        qr = client.qrcode.create({
            "type": "upi_qr",
            "name": "ESP32 POS Payment",
            "usage": "single_use",
            "fixed_amount": True,
            "payment_amount": amount_paise,
            "description": "ESP32 POS Transaction"
        })

        return jsonify({
            "status": "success",
            "qr_id": qr["id"],
            "image_url": qr["image_url"],
            "amount": amount_paise,
            "qr_status": qr["status"]
        })

    except Exception as e:
        logging.exception("Razorpay QR creation failed")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
