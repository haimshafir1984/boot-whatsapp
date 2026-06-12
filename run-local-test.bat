@echo off
setlocal

cd /d "%~dp0"

echo Starting FlowsBiz local test server...
echo.
echo URL: http://127.0.0.1:3091/client/
echo Login code: test-token
echo.
echo This test mode uses temporary files under C:\tmp.
echo It does not start a real WhatsApp/Baileys connection.
echo.

set PORT=3091
set WHATSAPP_PROVIDER=TWILIO_API
set CLIENT_ACCESS_TOKEN=test-token
set STORAGE_PATH=C:\tmp\flowsbiz-local-test-storage.json
set CONVERSATION_STATE_PATH=C:\tmp\flowsbiz-local-test-conversation-state.json
set OWNER_STORAGE_PATH=C:\tmp\flowsbiz-local-test-owner.json

echo Building...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed. Fix the errors above before testing.
  pause
  exit /b 1
)

echo.
echo Server is starting...
echo Keep this window open while testing.
echo.
node dist/index.js

pause
