!include nsDialogs.nsh
!include WinMessages.nsh
!include LogicLib.nsh

; Native mirror of the canonical palette in docs/design/design-tokens.css.
!define MM_COLOR_CANVAS "F7F7F9"
!define MM_COLOR_RAISED "FFFFFF"
!define MM_COLOR_INK "171717"
!define MM_COLOR_IRIS "1D4ED8"
!define MM_COLOR_MUTED "737373"
!define MM_COLOR_TRACK "E5E5E5"
!define MUI_BGCOLOR "${MM_COLOR_CANVAS}"
!define MUI_TEXTCOLOR "${MM_COLOR_INK}"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "确定要退出 MindMesh 安装吗？"
!define MM_HEADER_HEIGHT 44
!define MM_INSTALL_PATH_MAX 49

!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT MindMeshGUIInit
!endif

!macro customWelcomePage
  Page custom MindMeshInstallPageCreate MindMeshInstallPageLeave
!macroend

!macro customFinishPage
  Page custom MindMeshAutoLaunch
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW MindMeshStyleInstFilesPage
  !endif
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var MMDialog
    Var MMBtnNext
    Var MMBtnBack
    Var MMBtnCancel
    Var MMFontBrand
    Var MMFontTitle
    Var MMFontBody
    Var MMFontProgress
    Var MMClientWidth
    Var MMClientHeight
    Var MMPathText
    Var MMInstallButton
    Var MMProgressText
    Var MMProgressFill

    Function MindMeshGUIInit
      ; Replace the Windows title bar with a full-size branded surface.
      System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r0'
      IntOp $0 $0 & 0xFF30FFFF
      System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)'
      System::Call 'user32::GetSystemMetrics(i 0) i .r1'
      System::Call 'user32::GetSystemMetrics(i 1) i .r2'
      IntOp $1 $1 - 503
      IntOp $1 $1 / 2
      IntOp $2 $2 - 460
      IntOp $2 $2 / 2
      System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i 503, i 460, i 0x24)'
      System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i 504, i 461, i 24, i 24) p .r0'
      System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p r0, i 1)'

      CreateFont $MMFontBrand "Microsoft YaHei UI" 11 700
      CreateFont $MMFontTitle "Microsoft YaHei UI" 18 700
      CreateFont $MMFontBody "Microsoft YaHei UI" 9 400
      CreateFont $MMFontProgress "Microsoft YaHei UI" 26 500
      SetCtlColors $HWNDPARENT "${MM_COLOR_INK}" "${MM_COLOR_CANVAS}"

      System::Call 'user32::GetClientRect(p $HWNDPARENT, @r0)'
      System::Call '*$0(i, i, i .r1, i .r2)'
      StrCpy $MMClientWidth $1
      StrCpy $MMClientHeight $2

      GetDlgItem $MMBtnNext $HWNDPARENT 1
      ShowWindow $MMBtnNext ${SW_HIDE}
      GetDlgItem $MMBtnCancel $HWNDPARENT 2
      ShowWindow $MMBtnCancel ${SW_HIDE}
      GetDlgItem $MMBtnBack $HWNDPARENT 3
      ShowWindow $MMBtnBack ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1018
      IntOp $R0 $MMClientHeight - ${MM_HEADER_HEIGHT}
      System::Call 'user32::MoveWindow(p $0, i 0, i ${MM_HEADER_HEIGHT}, i $MMClientWidth, i $R0, i 0)'
      GetDlgItem $0 $HWNDPARENT 1256
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1028
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1034
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1037
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1038
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1039
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1045
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $HWNDPARENT 1046
      ShowWindow $0 ${SW_HIDE}

      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x50000003, i 14, i 7, i 30, i 30, p $HWNDPARENT, i 0, p 0, p 0) p .s'
      Pop $0
      System::Call 'kernel32::GetModuleHandleW(p 0) p .r1'
      System::Call 'user32::LoadImageW(p r1, t "#103", i 1, i 30, i 30, i 0) p .r1'
      SendMessage $0 0x0170 $1 0
      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "MindMesh", i 0x50000000, i 52, i 13, i 150, i 22, p $HWNDPARENT, i 0, p 0, p 0) p .s'
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBrand 1
      SetCtlColors $0 "${MM_COLOR_INK}" "${MM_COLOR_CANVAS}"
      IntOp $R0 $MMClientWidth - 43
      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "×", i 0x50000301, i $R0, i 8, i 32, i 28, p $HWNDPARENT, i 2, p 0, p 0) p .s'
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBrand 1
      SetCtlColors $0 "${MM_COLOR_INK}" "${MM_COLOR_CANVAS}"
    FunctionEnd

    Function MindMeshFitPage
      IntOp $R0 $MMClientHeight - ${MM_HEADER_HEIGHT}
      System::Call 'user32::MoveWindow(p $1, i 0, i ${MM_HEADER_HEIGHT}, i $MMClientWidth, i $R0, i 1)'
    FunctionEnd

    Function MindMeshInstallPageCreate
      InitPluginsDir
      File /oname=$PLUGINSDIR\MindMesh-User-Agreement.txt "${PROJECT_DIR}\docs\legal\USER_AGREEMENT.zh-CN.txt"
      File /oname=$PLUGINSDIR\MindMesh-Privacy-Policy.txt "${PROJECT_DIR}\docs\legal\PRIVACY_POLICY.zh-CN.txt"

      nsDialogs::Create 1018
      Pop $MMDialog
      StrCpy $1 $MMDialog
      Call MindMeshFitPage
      SetCtlColors $MMDialog "${MM_COLOR_INK}" "${MM_COLOR_RAISED}"

      ${NSD_CreateIcon} 126u 12u 48u 48u ""
      Pop $0
      ${NSD_SetIconFromInstaller} $0 $1
      ${NSD_CreateLabel} 0u 66u 300u 20u "安装 MindMesh"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontTitle 1
      SetCtlColors $0 "${MM_COLOR_INK}" "${MM_COLOR_RAISED}"
      ${NSD_CreateLabel} 0u 88u 300u 12u "多智能体创建与协作桌面平台"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBody 1
      SetCtlColors $0 "${MM_COLOR_MUTED}" "${MM_COLOR_RAISED}"

      ${NSD_CreateLabel} 38u 112u 224u 28u "安装"
      Pop $MMInstallButton
      ${NSD_AddStyle} $MMInstallButton ${WS_TABSTOP}|${SS_CENTER}|${SS_CENTERIMAGE}|${SS_NOTIFY}
      SendMessage $MMInstallButton ${WM_SETFONT} $MMFontBrand 1
      SetCtlColors $MMInstallButton "${MM_COLOR_RAISED}" "${MM_COLOR_IRIS}"
      System::Call 'user32::GetClientRect(p $MMInstallButton, @r0)'
      System::Call '*$0(i, i, i .r1, i .r2)'
      System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r1, i r2, i 18, i 18) p .r0'
      System::Call 'user32::SetWindowRgn(p $MMInstallButton, p r0, i 1)'
      ${NSD_OnClick} $MMInstallButton MindMeshStartInstall
      ; The hidden NSIS Next/Cancel controls retain Enter/Esc dialog semantics.
      System::Call 'user32::SetFocus(p $MMInstallButton)'

      ${NSD_CreateLabel} 61u 149u 78u 10u "安装即表示同意"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBody 1
      SetCtlColors $0 "${MM_COLOR_MUTED}" "${MM_COLOR_RAISED}"
      ${NSD_CreateLink} 138u 149u 42u 10u "用户协议"
      Pop $0
      ${NSD_OnClick} $0 MindMeshOpenUserAgreement
      ${NSD_CreateLabel} 180u 149u 8u 10u "和"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBody 1
      SetCtlColors $0 "${MM_COLOR_MUTED}" "${MM_COLOR_RAISED}"
      ${NSD_CreateLink} 188u 149u 48u 10u "隐私政策"
      Pop $0
      ${NSD_OnClick} $0 MindMeshOpenPrivacyPolicy

      ${NSD_CreateLabel} 18u 180u 42u 12u "安装到"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBrand 1
      SetCtlColors $0 "${MM_COLOR_INK}" "${MM_COLOR_RAISED}"
      ${NSD_CreateText} 61u 178u 184u 15u "$INSTDIR"
      Pop $MMPathText
      SendMessage $MMPathText ${WM_SETFONT} $MMFontBody 1
      SendMessage $MMPathText 0x00CF 1 0
      SetCtlColors $MMPathText "${MM_COLOR_MUTED}" "${MM_COLOR_RAISED}"
      ${NSD_CreateLink} 250u 179u 32u 12u "更改"
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBody 1
      ${NSD_OnClick} $0 MindMeshChooseInstallFolder

      nsDialogs::Show
    FunctionEnd

    Function MindMeshStartInstall
      Pop $0
      SendMessage $HWNDPARENT ${WM_COMMAND} 1 $MMBtnNext
    FunctionEnd

    Function MindMeshOpenUserAgreement
      Pop $0
      ExecShell "open" "$PLUGINSDIR\MindMesh-User-Agreement.txt"
    FunctionEnd

    Function MindMeshOpenPrivacyPolicy
      Pop $0
      ExecShell "open" "$PLUGINSDIR\MindMesh-Privacy-Policy.txt"
    FunctionEnd

    Function MindMeshChooseInstallFolder
      Pop $0
      nsDialogs::SelectFolderDialog "选择 MindMesh 安装位置" "$INSTDIR"
      Pop $0
      StrCmp $0 "error" chooseDone
      StrCpy $1 $0 8 -8
      StrCmp $1 "MindMesh" chooseValidate
      StrCpy $0 "$0\MindMesh"
      chooseValidate:
      StrLen $1 $0
      IntCmp $1 ${MM_INSTALL_PATH_MAX} chooseAccept chooseAccept chooseTooLong
      chooseTooLong:
      MessageBox MB_ICONEXCLAMATION "安装路径过长，请选择更短的目录。"
      Goto chooseDone
      chooseAccept:
      StrCpy $INSTDIR $0
      SendMessage $MMPathText ${WM_SETTEXT} 0 "STR:$INSTDIR"
      chooseDone:
    FunctionEnd

    Function MindMeshInstallPageLeave
      StrLen $0 $INSTDIR
      IntCmp $0 ${MM_INSTALL_PATH_MAX} installPathOk installPathOk installPathTooLong
      installPathTooLong:
      MessageBox MB_ICONEXCLAMATION "安装路径过长，请点击“更改”选择更短的目录。"
      Abort
      installPathOk:
    FunctionEnd

    Function MindMeshStyleInstFilesPage
      InitPluginsDir
      File /oname=$PLUGINSDIR\MindMesh-Progress.bmp "${PROJECT_DIR}\resources\installerProgress.bmp"

      StrCpy $1 $mui.InstFilesPage
      Call MindMeshFitPage
      SetCtlColors $mui.InstFilesPage "${MM_COLOR_INK}" "${MM_COLOR_RAISED}"

      ; MUI may restore the stock navigation controls while changing pages.
      ShowWindow $MMBtnNext ${SW_HIDE}
      ShowWindow $MMBtnBack ${SW_HIDE}
      ShowWindow $MMBtnCancel ${SW_HIDE}

      GetDlgItem $0 $mui.InstFilesPage 1006
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $mui.InstFilesPage 1016
      ShowWindow $0 ${SW_HIDE}
      GetDlgItem $0 $mui.InstFilesPage 1027
      ShowWindow $0 ${SW_HIDE}

      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x50000003, i 212, i 44, i 80, i 80, p $mui.InstFilesPage, i 0, p 0, p 0) p .s'
      Pop $0
      System::Call 'kernel32::GetModuleHandleW(p 0) p .r1'
      System::Call 'user32::LoadImageW(p r1, t "#103", i 1, i 80, i 80, i 0) p .r1'
      SendMessage $0 0x0170 $1 0
      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "0%", i 0x50000001, i 0, i 150, i $MMClientWidth, i 54, p $mui.InstFilesPage, i 0, p 0, p 0) p .s'
      Pop $MMProgressText
      SendMessage $MMProgressText ${WM_SETFONT} $MMFontProgress 1
      SetCtlColors $MMProgressText "${MM_COLOR_INK}" "${MM_COLOR_RAISED}"

      GetDlgItem $0 $mui.InstFilesPage 1004
      ShowWindow $0 ${SW_HIDE}
      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x50000000, i 102, i 222, i 299, i 10, p $mui.InstFilesPage, i 0, p 0, p 0) p .s'
      Pop $0
      SetCtlColors $0 "${MM_COLOR_TRACK}" "${MM_COLOR_TRACK}"
      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "", i 0x5000000E, i 102, i 222, i 1, i 10, p $mui.InstFilesPage, i 0, p 0, p 0) p .s'
      Pop $MMProgressFill
      System::Call 'user32::LoadImageW(p 0, t "$PLUGINSDIR\MindMesh-Progress.bmp", i 0, i 0, i 0, i 0x10) p .r0'
      SendMessage $MMProgressFill 0x0172 0 $0
      System::Call 'user32::CreateWindowExW(i 0, t "STATIC", t "正在安装，请稍候…", i 0x50000001, i 0, i 254, i $MMClientWidth, i 22, p $mui.InstFilesPage, i 0, p 0, p 0) p .s'
      Pop $0
      SendMessage $0 ${WM_SETFONT} $MMFontBody 1
      SetCtlColors $0 "${MM_COLOR_MUTED}" "${MM_COLOR_RAISED}"
      ${NSD_CreateTimer} MindMeshUpdateProgress 100
    FunctionEnd

    Function MindMeshUpdateProgress
      GetDlgItem $0 $mui.InstFilesPage 1004
      SendMessage $0 0x0408 0 0 $1
      SendMessage $0 0x0407 0 0 $2
      IntCmp $2 0 progressDone
      IntOp $1 $1 * 100
      IntOp $1 $1 / $2
      SendMessage $MMProgressText ${WM_SETTEXT} 0 "STR:$1%"
      IntOp $3 $1 * 299
      IntOp $3 $3 / 100
      ${If} $3 < 1
        StrCpy $3 1
      ${EndIf}
      System::Call 'user32::MoveWindow(p $MMProgressFill, i 102, i 222, i r3, i 10, i 1)'
      progressDone:
    FunctionEnd

    Function MindMeshAutoLaunch
      ${NSD_KillTimer} MindMeshUpdateProgress
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
      Quit
    FunctionEnd
  !endif
!macroend

!macro customInit
  IfSilent initSilent initDone
  initSilent:
  StrLen $0 $INSTDIR
  IntCmp $0 ${MM_INSTALL_PATH_MAX} initDone initDone initTooLong
  initTooLong:
  SetErrorLevel 87
  Quit
  initDone:
!macroend
