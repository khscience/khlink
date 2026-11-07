; Combined khLink installer: the desktop console and the background connector
; are installed by one NSIS package. The connector keeps running as its own
; scheduled task, so closing the console never takes the phone connection down.
;
; The connector payload is copied by Tauri into "$INSTDIR\connector".
; The task script is idempotent; PREINSTALL stops the previous copy so its
; node.exe and native modules can be replaced on upgrade.

; Set on a first install (no khLink there yet): the console then starts
; with Windows by default. An upgrade keeps whatever the user chose.
Var KhFreshInstall

!macro NSIS_HOOK_PREINSTALL
  StrCpy $KhFreshInstall "1"
  IfFileExists "$INSTDIR\kh-link-desktop.exe" 0 +2
    StrCpy $KhFreshInstall "0"
  DetailPrint "正在停止旧版 khLink 连接器……"
  IfFileExists "$INSTDIR\connector\connector-task.ps1" 0 +2
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\connector\connector-task.ps1" -Action stop'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "正在注册 khLink 后台连接器……"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\connector\connector-task.ps1" -Action install'
  StrCmp $KhFreshInstall "1" 0 +2
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "KHLink" '"$INSTDIR\kh-link-desktop.exe" --background'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在移除 khLink 后台连接器……"
  IfFileExists "$INSTDIR\connector\connector-task.ps1" 0 +2
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\connector\connector-task.ps1" -Action remove'
!macroend
