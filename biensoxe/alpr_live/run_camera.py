"""Run a pretrained ALPR pipeline on a webcam, video, or phone stream."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
import urllib.error

import cv2
from fast_alpr import ALPR


def parse_source(value: str) -> int | str:
    try:
        return int(value)
    except ValueError:
        return value


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Pretrained license plate recognition from a live camera source."
    )
    parser.add_argument(
        "--source",
        default="0",
        help="Webcam index (0), video file, or HTTP/RTSP phone-camera URL.",
    )
    parser.add_argument(
        "--detector",
        default="yolo-v9-t-384-license-plate-end2end",
        help="Pretrained FastALPR detector model name.",
    )
    parser.add_argument(
        "--ocr",
        default="cct-xs-v2-global-model",
        help="Pretrained FastPlateOCR model name.",
    )
    parser.add_argument("--confidence", type=float, default=0.35)
    parser.add_argument("--every", type=int, default=2, help="Run AI on every Nth frame.")
    parser.add_argument(
        "--cloud-url",
        default="https://iot-parking.onrender.com/api/parking/alpr",
        help="Endpoint URL of the IoT Smart Parking Cloud Web Server",
    )
    parser.add_argument(
        "--gate",
        default="entry",
        choices=["entry", "exit"],
        help="Gate location of this camera: 'entry' or 'exit'",
    )
    args = parser.parse_args()
    if args.every < 1:
        parser.error("--every must be at least 1")

    print("Loading pretrained detector and OCR models...")
    print("First start needs internet to download model files.")
    alpr = ALPR(
        detector_model=args.detector,
        detector_conf_thresh=args.confidence,
        ocr_model=args.ocr,
        ocr_device="cpu",
    )

    camera = cv2.VideoCapture(parse_source(args.source))
    if not camera.isOpened():
        raise RuntimeError("Could not open source. Check the camera number or stream URL.")
    camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    frame_number = 0
    last_printed: dict[str, float] = {}
    print("Camera ready. Press Q in the video window to quit.")
    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                print("No frame received; check that the camera stream is still active.")
                break
            frame_number += 1
            if frame_number % args.every == 0:
                for result in alpr.predict(frame):
                    bounds = result.detection.bounding_box
                    x1, y1, x2, y2 = map(
                        int, (bounds.x1, bounds.y1, bounds.x2, bounds.y2)
                    )
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
                    text = result.ocr.text if result.ocr else "Unreadable"
                    score = result.detection.confidence
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (40, 220, 40), 2)
                    cv2.putText(
                        frame,
                        f"{text} {score:.2f}",
                        (x1, max(24, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.65,
                        (40, 220, 40),
                        2,
                        cv2.LINE_AA,
                    )
                    if text and text != "Unreadable":
                        now = time.monotonic()
                        if now - last_printed.get(text, 0) >= 3:
                            print(f"[ALPR] Phat hien bien so: {text} (Do tin cay: {score:.2f})")
                            last_printed[text] = now
                            # Gui du lieu len Cloud Web Server
                            if args.cloud_url:
                                try:
                                    payload = json.dumps({
                                        "plate": text,
                                        "gate": args.gate,
                                        "confidence": float(score)
                                    }).encode("utf-8")
                                    req = urllib.request.Request(
                                        args.cloud_url,
                                        data=payload,
                                        headers={
                                            "Content-Type": "application/json",
                                            "X-API-Key": "IOT_SECURE_TOKEN_2026",
                                            "User-Agent": "FastALPR_Camera_Node/1.0"
                                        },
                                        method="POST"
                                    )
                                    with urllib.request.urlopen(req, timeout=3) as resp:
                                        res_data = json.loads(resp.read().decode("utf-8"))
                                        print(f" -> [Cloud Response] {res_data.get('action', 'OK')}")
                                except Exception as err:
                                    print(f" -> [Cloud Error] Khong the gui lenh: {err}")

            cv2.imshow("Pretrained ALPR - press Q to quit", frame)
            if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q")):
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
