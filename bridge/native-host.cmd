@echo off
rem Started by Chrome/Edge native messaging; stdout carries the protocol.
node "%~dp0native-host.mjs" %*
