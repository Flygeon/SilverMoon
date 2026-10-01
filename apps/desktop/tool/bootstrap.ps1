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

    Write-Host '[bootstrap] done'
}
finally {
    if (Test-Path $genDir) {
        Remove-Item -Recurse -Force $genDir -ErrorAction SilentlyContinue
    }
}
