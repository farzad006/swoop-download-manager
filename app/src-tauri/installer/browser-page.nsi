; Tauri's template leaves the installer's Company field empty; code signing
; (SignPath) expects consistent metadata on every signed file.
VIAddVersionKey "CompanyName" "${MANUFACTURER}"

; ---- Swoop: "Browser integration" page --------------------------------------
; Lists the browsers Windows knows about (Clients\StartMenuInternet), ticked by
; default. The choice is saved by NSIS_HOOK_POSTINSTALL (installer.nsh) and
; Swoop opens its "Connect your browsers" window for them on first start.
Var SwoopHasChrome
Var SwoopHasEdge
Var SwoopHasOpera
Var SwoopHasBrave
Var SwoopHasVivaldi
Var SwoopHasFirefox
Var SwoopSelChrome
Var SwoopSelEdge
Var SwoopSelOpera
Var SwoopSelBrave
Var SwoopSelVivaldi
Var SwoopSelFirefox
Var SwoopCbChrome
Var SwoopCbEdge
Var SwoopCbOpera
Var SwoopCbBrave
Var SwoopCbVivaldi
Var SwoopCbFirefox
Var SwoopScanned
Var SwoopBrowsers

!macro SwoopScanRoot ROOT KEY
  StrCpy $R9 0
  ${Do}
    EnumRegKey $R8 ${ROOT} "${KEY}" $R9
    ${IfThen} $R8 == "" ${|} ${Break} ${|}
    IntOp $R9 $R9 + 1
    StrCpy $R7 $R8 13
    ${IfThen} $R7 == "Google Chrome" ${|} StrCpy $SwoopHasChrome 1 ${|}
    StrCpy $R7 $R8 14
    ${IfThen} $R7 == "Microsoft Edge" ${|} StrCpy $SwoopHasEdge 1 ${|}
    StrCpy $R7 $R8 5
    ${IfThen} $R7 == "Opera" ${|} StrCpy $SwoopHasOpera 1 ${|}
    ${IfThen} $R7 == "Brave" ${|} StrCpy $SwoopHasBrave 1 ${|}
    StrCpy $R7 $R8 7
    ${IfThen} $R7 == "Vivaldi" ${|} StrCpy $SwoopHasVivaldi 1 ${|}
    ${IfThen} $R7 == "Firefox" ${|} StrCpy $SwoopHasFirefox 1 ${|}
  ${Loop}
!macroend

Function SwoopDetectBrowsers
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro SwoopScanRoot HKLM "SOFTWARE\Clients\StartMenuInternet"
  ${EndIf}
  SetRegView 32
  !insertmacro SwoopScanRoot HKLM "SOFTWARE\Clients\StartMenuInternet"
  !insertmacro SwoopScanRoot HKCU "SOFTWARE\Clients\StartMenuInternet"
  SetRegView lastused
  ; Everything found starts ticked.
  StrCpy $SwoopSelChrome $SwoopHasChrome
  StrCpy $SwoopSelEdge $SwoopHasEdge
  StrCpy $SwoopSelOpera $SwoopHasOpera
  StrCpy $SwoopSelBrave $SwoopHasBrave
  StrCpy $SwoopSelVivaldi $SwoopHasVivaldi
  StrCpy $SwoopSelFirefox $SwoopHasFirefox
  StrCpy $SwoopScanned 1
FunctionEnd

!macro SwoopBox CB HAS SEL Y LABEL
  ${NSD_CreateCheckbox} 12u ${Y} 100% 12u "${LABEL}"
  Pop ${CB}
  ${If} ${HAS} == 1
    ${IfThen} ${SEL} == 1 ${|} ${NSD_Check} ${CB} ${|}
  ${Else}
    ${NSD_SetText} ${CB} "${LABEL}   (not installed)"
    EnableWindow ${CB} 0
  ${EndIf}
!macroend

!macro SwoopRead CB HAS SEL ID
  ${If} ${HAS} == 1
    ${NSD_GetState} ${CB} $R0
    ${If} $R0 == ${BST_CHECKED}
      StrCpy ${SEL} 1
      StrCpy $SwoopBrowsers "$SwoopBrowsers,${ID}"
    ${Else}
      StrCpy ${SEL} 0
    ${EndIf}
  ${EndIf}
!macroend

Page custom SwoopBrowserPage SwoopBrowserPageLeave

Function SwoopBrowserPage
  ; Silent, passive and update installs keep whatever was set up before.
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  ${If} $SwoopScanned != 1
    Call SwoopDetectBrowsers
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Which browsers do you use?" "Swoop can pick up downloads and videos from them."
  nsDialogs::Create 1018
  Pop $R0
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 34u "Tick the browsers you use. When Swoop opens, it will show you how to connect each one. It takes about 20 seconds per browser, and you only do it once."
  Pop $R1

  !insertmacro SwoopBox $SwoopCbChrome $SwoopHasChrome $SwoopSelChrome 42u "Google Chrome"
  !insertmacro SwoopBox $SwoopCbEdge $SwoopHasEdge $SwoopSelEdge 56u "Microsoft Edge"
  !insertmacro SwoopBox $SwoopCbOpera $SwoopHasOpera $SwoopSelOpera 70u "Opera"
  !insertmacro SwoopBox $SwoopCbBrave $SwoopHasBrave $SwoopSelBrave 84u "Brave"
  !insertmacro SwoopBox $SwoopCbVivaldi $SwoopHasVivaldi $SwoopSelVivaldi 98u "Vivaldi"
  !insertmacro SwoopBox $SwoopCbFirefox $SwoopHasFirefox $SwoopSelFirefox 112u "Mozilla Firefox"

  ${NSD_CreateLabel} 0 130u 100% 12u "You can change this later in Swoop: Options > Browsers."
  Pop $R1
  nsDialogs::Show
FunctionEnd

Function SwoopBrowserPageLeave
  StrCpy $SwoopBrowsers ""
  !insertmacro SwoopRead $SwoopCbChrome $SwoopHasChrome $SwoopSelChrome "chrome"
  !insertmacro SwoopRead $SwoopCbEdge $SwoopHasEdge $SwoopSelEdge "edge"
  !insertmacro SwoopRead $SwoopCbOpera $SwoopHasOpera $SwoopSelOpera "opera"
  !insertmacro SwoopRead $SwoopCbBrave $SwoopHasBrave $SwoopSelBrave "brave"
  !insertmacro SwoopRead $SwoopCbVivaldi $SwoopHasVivaldi $SwoopSelVivaldi "vivaldi"
  !insertmacro SwoopRead $SwoopCbFirefox $SwoopHasFirefox $SwoopSelFirefox "firefox"
FunctionEnd
; ---- end Swoop ----------------------------------------------------------------

