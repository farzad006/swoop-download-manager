; OurIDM registers its browser native-messaging host itself on every start
; (HKCU, no admin). The uninstaller removes those registry entries again.
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\OurIDM.exe" --unregister'
!macroend
