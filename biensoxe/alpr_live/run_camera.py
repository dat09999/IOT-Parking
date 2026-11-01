"""Run a pretrained ALPR pipeline on a webcam, video, or phone stream."""

from __future__ import annotations

import argparse
import collections
import json
import threading
import time
import urllib.request
import urllib.error

import cv2
import numpy as np
from fast_alpr import ALPR

# Hàm tính độ sắc nét của ảnh (Laplacian Variance - Càng cao ảnh càng nét, không bị mờ/rung)
def calculate_sharpness(image_crop: np.ndarray) -> float:
    if image_crop is None or image_crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(image_crop, cv2.COLOR_BGR2GRAY) if len(image_crop.shape) == 3 else image_crop
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())

# Hàm gửi dữ liệu bất đồng bộ chạy ngầm (Non-blocking Thread) để camera mượt 60fps không bị lag
def post_to_cloud_async(url: str, payload_data: dict):
    def _worker():
        try:
            payload = json.dumps(payload_data).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-API-Key": "IOT_SECURE_TOKEN_2026",
                    "User-Agent": "FastALPR_Camera_Node/1.0"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=2) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                print(f" -> [Cloud Response] {res_data.get('action', 'OK')}")
        except Exception as err:
            print(f" -> [Cloud Error] {err}")

    t = threading.Thread(target=_worker, daemon=True)
    t.start()


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

    camera = cv2.VideoCapture(parse_source(args.source), cv2.CAP_DSHOW)
    if not camera.isOpened():
        camera = cv2.VideoCapture(parse_source(args.source))
    if not camera.isOpened():
        raise RuntimeError("Could not open source. Check the camera number or stream URL.")
    
    # Ép camera chạy độ phân giải 640x480 để xử lý tức thì không bị nghẽn
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    frame_number = 0
    last_printed: dict[str, float] = {}
    
    # Bộ đệm lưu ứng viên biển số: Giữ 3-5 frame gần nhất có độ nét cao nhất
    # Cấu trúc: list of {"text": str, "score": float, "sharpness": float, "crop": np.ndarray}
    plate_candidates = []
    last_detected_time = 0.0

    print("Camera ready. Press Q in the video window to quit.")
    try:
        while True:
            # Bỏ mọi frame đệm cũ để luôn lấy frame thời gian thực mới nhất 0ms độ trễ
            camera.grab()
            ok, frame = camera.read()
            if not ok:
                print("No frame received; check that the camera stream is still active.")
                break
            frame_number += 1
            now = time.monotonic()

            results = list(alpr.predict(frame))
            if results:
                for result in results:
                    bounds = result.detection.bounding_box
                    x1, y1, x2, y2 = map(
                        int, (bounds.x1, bounds.y1, bounds.x2, bounds.y2)
                    )
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
                    
                    plate_crop = frame[y1:y2, x1:x2]
                    sharpness = calculate_sharpness(plate_crop)
                    text = result.ocr.text if result.ocr else "Unreadable"
                    score = result.detection.confidence

                    cv2.rectangle(frame, (x1, y1), (x2, y2), (40, 220, 40), 2)
                    cv2.putText(
                        frame,
                        f"{text} {score:.2f} (Sharp:{sharpness:.0f})",
                        (x1, max(24, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (40, 220, 40),
                        2,
                        cv2.LINE_AA,
                    )

                    if text and text != "Unreadable" and len(text) >= 5:
                        plate_candidates.append({
                            "text": text,
                            "score": score,
                            "sharpness": sharpness,
                            "time": now
                        })
                        last_detected_time = now

            # Khi gom được 2 frame hoặc sau 0.15s là tuyển chọn ngay lập tức
            if plate_candidates and (len(plate_candidates) >= 2 or (now - last_detected_time > 0.15 and plate_candidates)):
                plate_candidates.sort(key=lambda c: (c["sharpness"] * 0.7 + c["score"] * 100 * 0.3), reverse=True)
                best_candidate = plate_candidates[0]
                chosen_plate = best_candidate["text"]
                best_score = best_candidate["score"]
                best_sharp = best_candidate["sharpness"]

                if now - last_printed.get(chosen_plate, 0) >= 2.0:
                    print(f"\n[AI BẮN NGAY TỨC THÌ] -> {chosen_plate} (Nét: {best_sharp:.0f}, Conf: {best_score:.2f})")
                    last_printed[chosen_plate] = now
                    if args.cloud_url:
                        post_to_cloud_async(args.cloud_url, {
                            "plate": chosen_plate,
                            "gate": args.gate,
                            "confidence": float(best_score)
                        })
                plate_candidates.clear()

            cv2.imshow("Pretrained ALPR - press Q to quit", frame)
            if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q")):
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
