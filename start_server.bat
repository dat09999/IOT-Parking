@echo off
title IoT Level-3 Cloud Smart Parking Server
color 0b
echo ====================================================================
echo       HE THONG QUAN LY BAI DO XE THONG MINH - IOT CAP DO 3
echo ====================================================================
echo.
echo Dang khoi dong Web Server, Database SQLite va MQTT Broker...
echo.

cd /d "%~dp0\web_server"
node server.js

pause
