; Combined khLink installer: the desktop console and the background connector
; are installed by one NSIS package. The connector keeps running as its own
; scheduled task, so closing the console never takes the phone connection down.
;
; The connector payload is copied by Tauri into "$INSTDIR\connector".
; The task script is idempotent; PREINSTALL stops the previous copy so its
; node.exe and native modules can be replaced on upgrade.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping the previous khLink connector..."
  IfFileExists "$INSTDIR\connector\connector-task.ps1" 0 +2
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\connector\connector-task.ps1" -Action stop'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering the khLink connector..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\connector\connector-task.ps1" -Action install'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing the khLink connector task..."
  IfFileExists "$INSTDIR\connector\connector-task.ps1" 0 +2
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\connector\connector-task.ps1" -Action remove'
!macroend
