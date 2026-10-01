<#
.SYNOPSIS
    SilverMoon 桌面端 · Windows 平台工程引导脚本。

.DESCRIPTION
    与 apps/mobile/tool/bootstrap.sh 同一策略：本仓库的开发机没有 Flutter SDK，
    windows/ 平台目录不入库，而是由 CI 在构建前用「当前 Flutter 版本自带的模板」
    现场生成，再把 tool/overlay/ 下的定制文件覆盖回去。

    这样做的好处是平台工程（CMakeLists / Runner.rc / runner 源码）永远与 Flutter
    版本匹配，不会出现「模板过期导致构建失败」。

    编码说明：本文件带 UTF-8 BOM。Windows PowerShell 5.1 在没有 BOM 时会按系统
    ANSI 代码页读取 .ps1，中文注释会被拆成乱码并连带吃掉后面的 { }，直接语法报错。
    不要手工去掉 BOM。

    环境变量：
      SILVERMOON_ORG           默认 cn.cool
      SILVERMOON_PROJECT_NAME  默认 silvermoon（决定 silvermoon.exe 的名字）

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/bootstrap.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
Set-Location $appDir

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
    throw '[bootstrap] flutter is not on PATH'
}

$org = if ($env:SILVERMOON_ORG) { $env:SILVERMOON_ORG } else { 'cn.cool' }
$projectName = if ($env:SILVERMOON_PROJECT_NAME) { $env:SILVERMOON_PROJECT_NAME } else { 'silvermoon' }

Write-Host "[bootstrap] app dir: $appDir"
Write-Host "[bootstrap] flutter create --org $org --project-name $projectName --platforms=windows"

$genDir = Join-Path ([System.IO.Path]::GetTempPath()) ('silvermoon-bootstrap-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $genDir | Out-Null

try {
    & flutter create --org $org --project-name $projectName --platforms=windows --no-pub $genDir
    if ($LASTEXITCODE -ne 0) {
        throw "[bootstrap] flutter create failed (exit $LASTEXITCODE)"
    }

    # 只取平台目录：Dart 源码 / pubspec / 测试全部以本仓库为准
    $target = Join-Path $appDir 'windows'
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
    }
    Copy-Item -Recurse -Force (Join-Path $genDir 'windows') $target
    Write-Host '[bootstrap] windows/ generated'

    # ---------- 覆盖定制文件 ----------
    $overlay = Join-Path $appDir 'tool/overlay'
    if (Test-Path $overlay) {
        Get-ChildItem -Recurse -File $overlay | ForEach-Object {
            $rel = $_.FullName.Substring($overlay.Length) -replace '^[\\/]+', ''
            $dest = Join-Path $appDir $rel
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            Copy-Item -Force $_.FullName $dest
            Write-Host "[bootstrap] overlay: $rel"
        }
    }
    else {
        Write-Host '[bootstrap] no tool/overlay directory, skipped'
    }

    # ---------- 修补第三方插件的 C++ 编译 ----------
    # webview_windows 的插件依赖 <experimental/coroutine>，而新版 MSVC（VS 18 / 14.5x）
    # 已把该头文件升成硬错误 STL1011（deprecated by Microsoft and will be REMOVED SOON）。
    # 官方给出的过渡开关就是下面这个宏，只有定义它才能继续编。
    #
    # 位置很讲究：必须写在 include(flutter/generated_plugins.cmake) **之前**。
    # add_compile_definitions 改的是 CMake 的目录属性，而目录属性只传播给「之后」
    # add_subdirectory 进来的子目录——插件正是那个子目录。
    $cmakeLists = Join-Path $target 'CMakeLists.txt'
    $marker = 'include(flutter/generated_plugins.cmake)'
    $define = '_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS'
    $raw = Get-Content -Raw -LiteralPath $cmakeLists
    if ($raw -notlike ('*' + $define + '*')) {
        if ($raw -notlike ('*' + $marker + '*')) {
            throw "[bootstrap] 模板里找不到 $marker，Flutter 模板结构变了，请检查本补丁"
        }
        $patch = (@(
                '# webview_windows 的 C++ 插件用到 <experimental/coroutine>，新版 MSVC (14.5x)',
                '# 已将该头文件升为硬错误 STL1011。定义官方过渡宏压掉；必须写在',
                '# include(flutter/generated_plugins.cmake) 之前，目录属性才会传播到插件子工程。',
                ('add_compile_definitions(' + $define + ')'),
                ''
            ) -join "`n")
        $raw = $raw.Replace($marker, $patch + $marker)
        Set-Content -LiteralPath $cmakeLists -Value $raw -NoNewline -Encoding utf8
        Write-Host "[bootstrap] patched: $define"
    }
    else {
        Write-Host '[bootstrap] coroutine deprecation macro already present, skipped'
    }

    Write-Host '[bootstrap] done'
}
finally {
    if (Test-Path $genDir) {
        Remove-Item -Recurse -Force $genDir -ErrorAction SilentlyContinue
    }
}
