!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择 MindMesh 的安装目录。为确保运行依赖完整，最终安装路径不能超过 49 个字符。"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  IfSilent initSilent initDone
  initSilent:
  StrLen $0 $INSTDIR
  IntCmp $0 49 initDone initDone initTooLong
  initTooLong:
  SetErrorLevel 87
  Quit
  initDone:
!macroend

Function .onVerifyInstDir
  StrLen $0 $INSTDIR
  StrCpy $1 -1
  verifyContainsAppName:
  IntOp $1 $1 + 1
  StrCpy $2 $INSTDIR 8 $1
  StrCmp $2 "MindMesh" verifyLength
  StrCmp $1 $0 verifyNeedsAppName
  Goto verifyContainsAppName
  verifyNeedsAppName:
  IntOp $0 $0 + 9
  verifyLength:
  IntCmp $0 49 verifyDone verifyDone verifyTooLong
  verifyTooLong:
  Abort
  verifyDone:
FunctionEnd
