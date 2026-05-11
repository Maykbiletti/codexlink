@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0blun-codex.ps1" %*
