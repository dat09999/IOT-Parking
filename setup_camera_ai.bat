@echo off
setlocal
title Cai dat Python cho Camera AI

echo Kiem tra Python 3.12...
py -3.12 --version
if errorlevel 1 goto missing_python

cd /d "%~dp0biensoxe\alpr_live"
if errorlevel 1 goto setup_error

echo.
echo Tao lai cau hinh moi truong Python tren may nay...
py -3.12 -m venv .venv
if errorlevel 1 goto setup_error

echo.
echo Cai thu vien AI. Can ket noi Internet, vui long cho...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto setup_error
".venv\Scripts\python.exe" -m pip uninstall -y opencv-python-headless
if errorlevel 1 goto setup_error
".venv\Scripts\python.exe" -m pip install --force-reinstall opencv-python
if errorlevel 1 goto setup_error
".venv\Scripts\python.exe" -c "import cv2; from fast_alpr import ALPR; print('Thu vien AI: OK')"
if errorlevel 1 goto setup_error

echo.
echo [OK] Cai dat xong. Hay mo iVCam roi chay start_ivcam_ai.bat.
pause
exit /b 0

:missing_python
echo.
echo [LOI] Chua tim thay Python 3.12.
echo Cai Python 3.12 ban 64-bit tu trang python.org, kem Python Launcher.
echo Sau khi cai xong, mo lai file setup_camera_ai.bat nay.
pause
exit /b 1

:setup_error
echo.
echo [LOI] Cai dat chua hoan tat. Hay chup lai thong bao loi o tren.
pause
exit /b 1
