@echo off
title AI Camera Bien So Xe - iVCam - Cloud Smart Parking
color 0a

echo ====================================================================
echo   KHOI DONG CAMERA AI QUA iVCAM (DIEN THOAI)
echo   Ket noi truc tiep Cloud: https://iot-parking.onrender.com
echo ====================================================================
echo.
echo Luu y: Hay mo iVCam tren dien thoai va ket noi voi may tinh truoc!
echo.

cd /d "%~dp0\biensoxe\alpr_live"
if errorlevel 1 goto folder_error

:: Thu camera index mac dinh la 0 hoac 1
set CAM_INDEX=0
echo.
echo Danh sach lua chon Camera:
echo   [0] Camera 0 (Mac dinh hoac Webcam / iVCam)
echo   [1] Camera 1 (iVCam hoac Camera phu)
echo.
set /p USER_CHOICE="Chon camera [Nhan Enter mac dinh la 0, hoac go 1]: "
if not "%USER_CHOICE%"=="" set CAM_INDEX=%USER_CHOICE%

if exist ".venv\Scripts\python.exe" (
    echo Kiem tra Python cua du an...
    ".venv\Scripts\python.exe" --version
    if errorlevel 1 goto python_error
    echo Dang chay AI voi iVCam - Camera %CAM_INDEX%...
    ".venv\Scripts\python.exe" run_camera.py --source %CAM_INDEX% --cloud-url https://iot-parking.onrender.com/api/parking/alpr
) else (
    python --version
    if errorlevel 1 goto python_error
    echo Dang chay AI voi iVCam - Camera %CAM_INDEX%...
    python run_camera.py --source %CAM_INDEX% --cloud-url https://iot-parking.onrender.com/api/parking/alpr
)

if errorlevel 1 echo [LOI] AI chua chay duoc. Hay chup lai thong bao loi o tren.
echo.
pause
exit /b

:python_error
echo.
echo [LOI] Python chua duoc cai hoac moi truong .venv bi hong.
echo Neu thay duong dan C:\Users\ADMIN thi .venv dang tro toi Python cua may cu.
echo Hay cai Python 3.12 ban 64-bit, kem Python Launcher.
echo Sau do chay setup_camera_ai.bat trong thu muc IOT de sua moi truong.
echo.
pause
exit /b 1

:folder_error
echo.
echo [LOI] Khong tim thay thu muc biensoxe\alpr_live.
echo Hay giu file start_ivcam_ai.bat trong thu muc IOT goc.
pause
exit /b 1
