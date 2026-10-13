; OurIDM registers its browser native-messaging host itself on every start
; (HKCU, no admin). The uninstaller removes those registry entries again.

; Browsers ticked on the "Browser integration" page (installer/installer.nsi):
; OurIDM reads and clears this on its next start and opens its setup window.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $OurIdmBrowsers != ""
    WriteRegStr HKCU "Software\OurIDM" "SetupBrowsers" "$OurIdmBrowsers"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\OurIDM.exe" --unregister'
  DeleteRegKey HKCU "Software\OurIDM"
!macroend
