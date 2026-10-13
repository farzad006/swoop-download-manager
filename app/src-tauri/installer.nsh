; Swoop registers its browser native-messaging host itself on every start
; (HKCU, no admin). The uninstaller removes those registry entries again.

; Browsers ticked on the "Browser integration" page (installer/installer.nsi):
; Swoop reads and clears this on its next start and opens its setup window.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $SwoopBrowsers != ""
    WriteRegStr HKCU "Software\Swoop" "SetupBrowsers" "$SwoopBrowsers"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\Swoop.exe" --unregister'
  DeleteRegKey HKCU "Software\Swoop"
!macroend
