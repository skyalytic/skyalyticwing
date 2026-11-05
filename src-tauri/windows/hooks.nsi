!include "${__FILEDIR__}\runtime.nsh"

!define WING_RECOVERY_SOURCE "${__FILEDIR__}\..\..\scripts\update-recovery.cjs"
!define WING_CLI_CHECK_SOURCE "${__FILEDIR__}\..\..\packages\web\bin\check-closed.ps1"
!define WING_PRUNE_BUILD_SOURCE "${__FILEDIR__}\..\..\scripts\prune-installed-build.cjs"
Var WingRecoveryDir
Var WingInstallerPid

; Abort rather than terminating a running editor. Works for both manual installers
; and updater installs (the latter have already drained/saved and exited).
!macro WING_REQUIRE_CLOSED
  nsExec::ExecToStack `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "for ($$i=0; $$i -lt 20; $$i++) { if (!(Get-Process SkyalyticWing,SkyalyticClaw -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"`
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存文档、结束任务，并从托盘完全退出 Wing。"
    Abort
  ${EndIf}
!macroend

!macro WING_REQUIRE_CLI_CLOSED CHECKER
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${CHECKER}" -InstallDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存文档、结束任务，退出 Wing CLI，并从托盘完全退出 Wing，再重新运行安装或卸载程序。"
    Abort
  ${EndIf}
!macroend

!macro WING_UPDATE_PHASE PHASE
  ${If} $WingRecoveryDir != ""
    nsExec::ExecToStack '"$WingRecoveryDir\recovery-node.exe" "$WingRecoveryDir\recovery.cjs" phase "$WingRecoveryDir" "${PHASE}" "$WingInstallerPid"'
    Pop $0
    Pop $1
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\update-recovery.cjs "${WING_RECOVERY_SOURCE}"
  File /oname=$PLUGINSDIR\prune-installed-build.cjs "${WING_PRUNE_BUILD_SOURCE}"
  File /oname=$PLUGINSDIR\wing-check-closed.ps1 "${WING_CLI_CHECK_SOURCE}"
  !insertmacro WING_REQUIRE_CLI_CLOSED "$PLUGINSDIR\wing-check-closed.ps1"
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $WingInstallerPid $0
  ${GetOptions} $CMDLINE "/WINGRECOVERY=" $WingRecoveryDir
  ${If} $WingRecoveryDir == ""
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; A manual upgrade also snapshots the old program and actual user-data root.
    InitPluginsDir
    SetOutPath $PLUGINSDIR
    File /oname=wing-recovery.cjs "${WING_RECOVERY_SOURCE}"
    CopyFiles /SILENT "$INSTDIR\node.exe" "$PLUGINSDIR\wing-recovery-node.exe"
    nsExec::ExecToStack '"$PLUGINSDIR\wing-recovery-node.exe" "$PLUGINSDIR\wing-recovery.cjs" manual "$INSTDIR" "${VERSION}" "$WingInstallerPid"'
    Pop $0
    Pop $WingRecoveryDir
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "更新备份未完成，安装已停止。请检查磁盘空间和文件访问权限。"
      StrCpy $WingRecoveryDir ""
      Abort
    ${EndIf}
    SetOutPath $INSTDIR
  ${EndIf}
  !insertmacro WING_UPDATE_PHASE "installing"
  ${If} $WingRecoveryDir != ""
  ${AndIf} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法验证更新恢复记录，安装已停止。"
    Abort
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    nsExec::ExecToStack '"$INSTDIR\node.exe" "$PLUGINSDIR\prune-installed-build.cjs" "$INSTDIR" "$WingRecoveryDir"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "旧程序文件清理未完成，安装已停止。更新备份将保留以便恢复。"
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Each native executable needs CRTs beside itself. A copy under Python is not
  ; searched by the Wing shell or the desktop automation bridge.
  !insertmacro WING_INSTALL_CRT "$INSTDIR"
  !insertmacro WING_INSTALL_CRT "$INSTDIR\_up_\packages\web\binaries"
  SetOutPath "$INSTDIR"
  ; Run install.cjs to register CLI command and add to PATH
  ExecWait '"$INSTDIR\node.exe" "$INSTDIR\_up_\packages\web\bin\install.cjs"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop the application tree before Restart Manager closes the native window.
  ; This also releases bundled Node/native modules and avoids orphan sidecars.
  !insertmacro WING_REQUIRE_CLI_CLOSED "$INSTDIR\_up_\packages\web\bin\check-closed.ps1"
  ; Run uninstall.cjs to remove CLI command and PATH entry
  ExecWait '"$INSTDIR\node.exe" "$INSTDIR\_up_\packages\web\bin\uninstall.cjs"'
  !insertmacro WING_REMOVE_CRT "$INSTDIR"
  !insertmacro WING_REMOVE_CRT "$INSTDIR\_up_\packages\web\binaries"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Also delete legacy app data directories when user chose to delete app data.
  ; Data dir history: com.skyalyticclaw.desktop (bundle id, <=1.3.3) -> SkyalyticClaw
  ; (post-rename) -> SkyalyticWing (current). The backend migrates the chain on
  ; first launch and removes the legacy dir, but if that never ran (e.g. the new
  ; version was installed but never started), legacy data survives uninstall and
  ; gets re-migrated on reinstall — wipe every historical dir here.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    !if "${BUNDLEID}" == "com.skyalyticwing.community"
      RmDir /r "$APPDATA\SkyalyticWingCommunity"
    !else if "${BUNDLEID}" == "com.skyalyticwing.enterprise"
      RmDir /r "$APPDATA\SkyalyticWingEnterprise"
    !else
    RmDir /r "$APPDATA\SkyalyticWing"
    RmDir /r "$LOCALAPPDATA\SkyalyticWing"
    RmDir /r "$APPDATA\SkyalyticClaw"
    RmDir /r "$LOCALAPPDATA\SkyalyticClaw"
    RmDir /r "$APPDATA\com.skyalyticclaw.desktop"
    RmDir /r "$LOCALAPPDATA\com.skyalyticclaw.desktop"
    !endif
  ${EndIf}
!macroend
