; SilverMoon NSIS 自定义脚本
; ============================
;
; 只做一件事：把**快捷方式与安装后启动都指向原生启动器**
; （silvermoon-splash.exe），而不是 Electron 本体（SilverMoon.exe）。
;
; 为什么必须这么做：splash 的全部价值在于「盖住 Electron 冷启动的空窗期」。
; 若快捷方式直接拉 Electron，用户看到的仍是原来那段空白等待，启动器根本不执行。
;
; 由 electron-builder 的 nsis.include 引入（见 electron-builder.yml）。
; NsisTarget 加载它后，宏 customInstall 会在「安装文件 + 建快捷方式」之后
; 被 !ifmacrodef 调用（见模板 installSection.nsh）。
;
; 时序说明（installSection.nsh）：
;   line 12  !insertmacro setLinkVars       —— 设定 $newDesktopLink / $newStartMenuLink
;   line 68  !insertmacro addStartMenuLink  —— 建出指向 $appExe 的快捷方式
;   line 69  !insertmacro addDesktopLink     —— 同上
;   line 81  !insertmacro customInstall      —— 我们在这里覆盖指向
; 因此本宏执行时快捷方式**已经存在**且指向 Electron，直接删掉重建即可。
;
; 刻意**不**引用 ${isNoDesktopShortcut} / ${isNoStartMenuShortcut}：
; 这两个符号被 electron-builder 模板 installer.nsh 引用，但整个包里没有任何
; 地方定义它们（已全仓 grep 确认）。跟着用会直接编译失败，故一律避开；
; 我们的 electron-builder.yml 已固定 createDesktopShortcut/createStartMenuShortcut
; 为 true，本来就会创建，无需再判。
;
; 注意：**不重命名 Electron 本体**。SilverMoon.exe 必须留在原位 ——
; Electron 的 app.asar、资源路径、自动更新都依赖它；我们只改快捷方式指向。

!macro customInstall
  ; 防重复展开（多用户安装路径下宏可能被插入两次）
  !ifndef SILVERMOON_SPLASH_LINK_DONE
    !define SILVERMOON_SPLASH_LINK_DONE

    ; 启动器与 Electron 同级落盘（见 electron-builder.yml 的 win.extraResources）
    StrCpy $R9 "$INSTDIR\silvermoon-splash.exe"

    ${If} ${FileExists} "$R9"
      ; ---- 桌面快捷方式：改指启动器 ----
      ${If} ${FileExists} "$newDesktopLink"
        Delete "$newDesktopLink"
      ${EndIf}
      CreateShortCut "$newDesktopLink" "$R9" "" "$R9" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

      ; ---- 开始菜单快捷方式：同上 ----
      ${If} ${FileExists} "$newStartMenuLink"
        Delete "$newStartMenuLink"
      ${EndIf}
      CreateShortCut "$newStartMenuLink" "$R9" "" "$R9" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

      ; ---- 安装完成后的「立即运行」也走启动器 ----
      ; installSection.nsh 默认把 $launchLink 指向 $appExe（Electron 本体），
      ; 这里覆盖它，让首次启动同样有 splash 过渡。
      StrCpy $launchLink "$R9"
    ${Else}
      ; 启动器缺失（构建异常）：保留原指向，至少应用还能启动。
      DetailPrint "警告：未找到启动器，快捷方式将直接指向主程序"
    ${EndIf}
  !endif
!macroend
