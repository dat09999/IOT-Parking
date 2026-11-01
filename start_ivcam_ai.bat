@echo off
title AI Camera Bien So Xe (iVCam Phone Camera) -> Cloud Smart Parking
color 0a

echo ====================================================================
echo   KHOI DONG CAMERA AI QUA iVCAM (DIEN THOAI)
echo   Ket noi truc tiep Cloud: https://iot-parking.onrender.com
echo ====================================================================
echo.
echo Luu y: Hay mo iVCam tren dien thoai va ket noi voi may tinh truoc!
echo.

cd /d "%~dp0\biensoxe\alpr_live"

:: Thu camera index 1 (iVCam thuong la camera so 1 neu laptop co webcam roi)
:: Neu khong thay hinh iVCam, ban co the doi so 1 thanh 2 hoac 0
set CAM_INDEX=1

if exist ".venv\Scripts\python.exe" (
    echo Dang chay AI voi iVCam (Camera %CAM_INDEX%)...
    .venv\Scripts\python.exe run_camera.py --source %CAM_INDEX% --cloud-url https://iot-parking.onrender.com/api/parking/alpr
) else (
    echo Dang chay AI voi iVCam (Camera %CAM_INDEX%)...
    python run_camera.py --source %CAM_INDEX% --cloud-url https://iot-parking.onrender.com/api/parking/alpr
)

pause
