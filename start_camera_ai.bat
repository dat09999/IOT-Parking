@echo off
title AI License Plate Recognition (FastALPR) -> Cloud Smart Parking
color 0a

echo ====================================================================
echo   KHOI DONG CAMERA AI NHAN DIEN BIEN SO XE (FAST ALPR)
echo   Ket noi truc tiep Cloud: https://iot-parking.onrender.com
echo ====================================================================
echo.

cd /d "%~dp0\biensoxe\alpr_live"

if exist ".venv\Scripts\python.exe" (
    echo Dang khoi dong bang moi truong ao .venv...
    .venv\Scripts\python.exe run_camera.py --source 0 --cloud-url https://iot-parking.onrender.com/api/parking/alpr
) else (
    echo Dang khoi dong bang Python he thong...
    python run_camera.py --source 0 --cloud-url https://iot-parking.onrender.com/api/parking/alpr
)

pause
