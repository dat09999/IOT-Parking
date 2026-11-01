# Nhận diện biển số bằng trọng số có sẵn

Bản này không dùng dữ liệu hay trọng số trong `train_bien_so_xe`. FastALPR tự
tải model detector và OCR có sẵn ở lần chạy đầu. Cần Internet lần đầu để tải
model; các lần sau dùng bản đã lưu trên máy.

## Cài đặt trên Windows

Mở PowerShell tại thư mục `alpr_live`, chạy:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip uninstall -y opencv-python-headless
.\.venv\Scripts\python.exe -m pip install opencv-python
```

## Mở webcam máy tính

```powershell
.\.venv\Scripts\python.exe run_camera.py --source 0
```

## Mở camera điện thoại

1. Cài ứng dụng camera IP trên điện thoại và bật chế độ phát luồng.
2. Cho điện thoại và máy tính vào cùng mạng Wi-Fi.
3. Sao chép URL HTTP hoặc RTSP mà ứng dụng hiển thị.
4. Chạy chương trình với URL đó:

```powershell
.\.venv\Scripts\python.exe run_camera.py --source "http://DIA_CHI_IP:CONG/video"
```

Thay URL ví dụ bằng địa chỉ thật do ứng dụng điện thoại cung cấp. Nhấn `Q` ở
cửa sổ camera để dừng.

## Tốc độ và giới hạn

Mặc định AI chạy trên CPU, xử lý mỗi khung hình thứ hai. Có thể chỉnh bằng
`--every 1` (xử lý mọi khung hình) hoặc `--every 3` (nhẹ hơn, phản hồi chậm hơn).
FastALPR có detector và OCR pretrained, hỗ trợ truyền trực tiếp ảnh OpenCV vào
pipeline. Model OCR là loại global, không được huấn luyện riêng cho biển Việt
Nam, nên cần thử bằng ảnh biển số Việt Nam trước khi dựa vào kết quả.

Phần nhận diện hiện chạy trên máy tính. Chưa gửi biển số tới ESP32 hay Blynk;
đó là bước tích hợp riêng sau khi xác nhận nhận diện chạy ổn.
