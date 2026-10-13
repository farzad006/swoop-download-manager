; ---- OurIDM: "Browser integration" page --------------------------------------
; Lists the browsers Windows knows about (Clients\StartMenuInternet), ticked by
; default. The choice is saved by NSIS_HOOK_POSTINSTALL (installer.nsh) and
; OurIDM opens its "Connect your browsers" window for them on first start.
Var OurIdmHasChrome
Var OurIdmHasEdge
Var OurIdmHasOpera
Var OurIdmHasBrave
Var OurIdmHasVivaldi
Var OurIdmHasFirefox
Var OurIdmSelChrome
Var OurIdmSelEdge
Var OurIdmSelOpera
Var OurIdmSelBrave
Var OurIdmSelVivaldi
Var OurIdmSelFirefox
Var OurIdmCbChrome
Var OurIdmCbEdge
Var OurIdmCbOpera
Var OurIdmCbBrave
Var OurIdmCbVivaldi
Var OurIdmCbFirefox
Var OurIdmScanned
Var OurIdmBrowsers

!macro OurIdmScanRoot ROOT KEY
  StrCpy $R9 0
  ${Do}
    EnumRegKey $R8 ${ROOT} "${KEY}" $R9
    ${IfThen} $R8 == "" ${|} ${Break} ${|}
    IntOp $R9 $R9 + 1
    StrCpy $R7 $R8 13
    ${IfThen} $R7 == "Google Chrome" ${|} StrCpy $OurIdmHasChrome 1 ${|}
    StrCpy $R7 $R8 14
    ${IfThen} $R7 == "Microsoft Edge" ${|} StrCpy $OurIdmHasEdge 1 ${|}
    StrCpy $R7 $R8 5
    ${IfThen} $R7 == "Opera" ${|} StrCpy $OurIdmHasOpera 1 ${|}
    ${IfThen} $R7 == "Brave" ${|} StrCpy $OurIdmHasBrave 1 ${|}
    StrCpy $R7 $R8 7
    ${IfThen} $R7 == "Vivaldi" ${|} StrCpy $OurIdmHasVivaldi 1 ${|}
    ${IfThen} $R7 == "Firefox" ${|} StrCpy $OurIdmHasFirefox 1 ${|}
  ${Loop}
!macroend

Function OurIdmDetectBrowsers
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro OurIdmScanRoot HKLM "SOFTWARE\Clients\StartMenuInternet"
  ${EndIf}
  SetRegView 32
  !insertmacro OurIdmScanRoot HKLM "SOFTWARE\Clients\StartMenuInternet"
  !insertmacro OurIdmScanRoot HKCU "SOFTWARE\Clients\StartMenuInternet"
  SetRegView lastused
  ; Everything found starts ticked.
  StrCpy $OurIdmSelChrome $OurIdmHasChrome
  StrCpy $OurIdmSelEdge $OurIdmHasEdge
  StrCpy $OurIdmSelOpera $OurIdmHasOpera
  StrCpy $OurIdmSelBrave $OurIdmHasBrave
  StrCpy $OurIdmSelVivaldi $OurIdmHasVivaldi
  StrCpy $OurIdmSelFirefox $OurIdmHasFirefox
  StrCpy $OurIdmScanned 1
FunctionEnd

!macro OurIdmBox CB HAS SEL Y LABEL
  ${NSD_CreateCheckbox} 12u ${Y} 100% 12u "${LABEL}"
  Pop ${CB}
  ${If} ${HAS} == 1
    ${IfThen} ${SEL} == 1 ${|} ${NSD_Check} ${CB} ${|}
  ${Else}
    ${NSD_SetText} ${CB} "${LABEL}   (not installed)"
    EnableWindow ${CB} 0
  ${EndIf}
!macroend

!macro OurIdmRead CB HAS SEL ID
  ${If} ${HAS} == 1
    ${NSD_GetState} ${CB} $R0
    ${If} $R0 == ${BST_CHECKED}
      StrCpy ${SEL} 1
      StrCpy $OurIdmBrowsers "$OurIdmBrowsers,${ID}"
    ${Else}
      StrCpy ${SEL} 0
    ${EndIf}
  ${EndIf}
!macroend

Page custom OurIdmBrowserPage OurIdmBrowserPageLeave

Function OurIdmBrowserPage
  ; Silent, passive and update installs keep whatever was set up before.
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  ${If} $OurIdmScanned != 1
    Call OurIdmDetectBrowsers
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Which browsers do you use?" "OurIDM can pick up downloads and videos from them."
  nsDialogs::Create 1018
  Pop $R0
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 34u "Tick the browsers you use. When OurIDM opens, it will show you how to connect each one. It takes about 20 seconds per browser, and you only do it once."
  Pop $R1

  !insertmacro OurIdmBox $OurIdmCbChrome $OurIdmHasChrome $OurIdmSelChrome 42u "Google Chrome"
  !insertmacro OurIdmBox $OurIdmCbEdge $OurIdmHasEdge $OurIdmSelEdge 56u "Microsoft Edge"
  !insertmacro OurIdmBox $OurIdmCbOpera $OurIdmHasOpera $OurIdmSelOpera 70u "Opera"
  !insertmacro OurIdmBox $OurIdmCbBrave $OurIdmHasBrave $OurIdmSelBrave 84u "Brave"
  !insertmacro OurIdmBox $OurIdmCbVivaldi $OurIdmHasVivaldi $OurIdmSelVivaldi 98u "Vivaldi"
  !insertmacro OurIdmBox $OurIdmCbFirefox $OurIdmHasFirefox $OurIdmSelFirefox 112u "Mozilla Firefox"

  ${NSD_CreateLabel} 0 130u 100% 12u "You can change this later in OurIDM: Options > Browsers."
  Pop $R1
  nsDialogs::Show
FunctionEnd

Function OurIdmBrowserPageLeave
  StrCpy $OurIdmBrowsers ""
  !insertmacro OurIdmRead $OurIdmCbChrome $OurIdmHasChrome $OurIdmSelChrome "chrome"
  !insertmacro OurIdmRead $OurIdmCbEdge $OurIdmHasEdge $OurIdmSelEdge "edge"
  !insertmacro OurIdmRead $OurIdmCbOpera $OurIdmHasOpera $OurIdmSelOpera "opera"
  !insertmacro OurIdmRead $OurIdmCbBrave $OurIdmHasBrave $OurIdmSelBrave "brave"
  !insertmacro OurIdmRead $OurIdmCbVivaldi $OurIdmHasVivaldi $OurIdmSelVivaldi "vivaldi"
  !insertmacro OurIdmRead $OurIdmCbFirefox $OurIdmHasFirefox $OurIdmSelFirefox "firefox"
FunctionEnd
; ---- end OurIDM ----------------------------------------------------------------

