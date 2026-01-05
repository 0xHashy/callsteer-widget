!macro customInstall
  ; Add option to run at Windows startup
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CallSteer" "$INSTDIR\CallSteer.exe"
!macroend

!macro customUnInstall
  ; Remove startup registry entry
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CallSteer"
!macroend
