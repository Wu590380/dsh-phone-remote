# 免 Gradle 构建「电脑 dsh」APK：aapt2 + javac + d8 + zipalign + apksigner
# 依赖：JDK 21（已装）、Android SDK 组件（E:\android-sdk：platforms;android-32 + build-tools;32.0.0）
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root   = $PSScriptRoot
$SDK    = 'E:\android-sdk'
$BT     = Join-Path $SDK 'build-tools\32.0.0'
$JAR    = Join-Path $SDK 'platforms\android-32\android.jar'
$JAVA   = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot'
$JAVAC  = Join-Path $JAVA 'bin\javac.exe'
$KEYTOOL= Join-Path $JAVA 'bin\keytool.exe'
$Build  = Join-Path $Root 'build'
$Out    = Join-Path $Root 'pc-dsh.apk'
$KS     = Join-Path $Root 'debug.keystore'

foreach ($p in @($BT, $JAR, $JAVAC)) { if (-not (Test-Path $p)) { throw "缺少构建件: $p" } }

if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Build, "$Build\gen", "$Build\classes", "$Build\dex" | Out-Null

Write-Host '① aapt2 编译资源…' -ForegroundColor Cyan
& "$BT\aapt2.exe" compile --dir (Join-Path $Root 'res') -o "$Build\res.flata"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

Write-Host '② aapt2 链接（生成 R.java + 未签名 APK）…' -ForegroundColor Cyan
& "$BT\aapt2.exe" link -o "$Build\app-unsigned.apk" `
    -I $JAR `
    --manifest (Join-Path $Root 'AndroidManifest.xml') `
    -R "$Build\res.flata" `
    --java "$Build\gen" `
    --min-sdk-version 24 --target-sdk-version 32 `
    --version-code 1 --version-name 1.0 `
    --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

Write-Host '③ javac 编译 Java（目标 11，Android 可 dex）…' -ForegroundColor Cyan
# ③.0 把本地密钥注入源码副本（仓库里的 Config.java 只放占位符；真值在 mobile-control\secrets.local.json，不入库）
$srcDir = Join-Path $Build 'src'
Copy-Item (Join-Path $Root 'java') $srcDir -Recurse -Force
$secretsFile = Join-Path (Split-Path $Root -Parent) 'secrets.local.json'
if (Test-Path $secretsFile) {
    try {
        $s = Get-Content $secretsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $cfg = Join-Path $srcDir 'com\mc\pcbridge\Config.java'
        $c = [System.IO.File]::ReadAllText($cfg, [System.Text.Encoding]::UTF8)
        if ($s.mcpUrl)     { $c = $c -replace 'MCP_URL\s*=\s*"[^"]*"',   ('MCP_URL = "' + $s.mcpUrl + '"') }
        if ($s.mcpToken)   { $c = $c -replace 'MCP_TOKEN\s*=\s*"[^"]*"', ('MCP_TOKEN = "' + $s.mcpToken + '"') }
        if ($s.panelUrl)   { $c = $c -replace 'PANEL_URL\s*=\s*"[^"]*"', ('PANEL_URL = "' + $s.panelUrl + '"') }
        if ($s.panelToken) { $c = $c -replace 'PANEL_TOKEN\s*=\s*"[^"]*"', ('PANEL_TOKEN = "' + $s.panelToken + '"') }
        [System.IO.File]::WriteAllText($cfg, $c, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host '   （已注入本地密钥 secrets.local.json）' -ForegroundColor DarkYellow
    } catch { Write-Host ('   注入密钥失败（用占位符继续）: ' + $_.Exception.Message) -ForegroundColor DarkYellow }
} else {
    Write-Host '   （未找到 secrets.local.json，APK 里将是占位符，无法连上你的电脑）' -ForegroundColor DarkYellow
}
$srcs = @()
$srcs += Get-ChildItem -Path "$Build\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$srcs += Get-ChildItem -Path $srcDir -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& $JAVAC -nowarn --release 11 -cp $JAR -d "$Build\classes" @srcs 2>&1 |
    Where-Object { $_ -notmatch 'bootstrap class path|警告|warning' } | ForEach-Object { "   $_" }
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

Write-Host '④ d8 生成 classes.dex…' -ForegroundColor Cyan
$classes = Get-ChildItem -Path "$Build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& java -Xmx2g -cp "$BT\lib\d8.jar" com.android.tools.r8.D8 --lib $JAR --min-api 24 --output "$Build\dex" @classes 2>&1 | Select-Object -Last 6 | ForEach-Object { "   $_" }
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

Write-Host '⑤ 把 classes.dex 塞进 APK…' -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$Build\app-unsigned.apk", 'Update')
$dex = Get-ChildItem "$Build\dex" -Filter *.dex | Select-Object -First 1
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dex.FullName, 'classes.dex', [System.IO.Compression.CompressionLevel]::NoCompression) | Out-Null
$zip.Dispose()

Write-Host '⑥ zipalign…' -ForegroundColor Cyan
& "$BT\zipalign.exe" -f 4 "$Build\app-unsigned.apk" "$Build\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

if (-not (Test-Path $KS)) {
    Write-Host '⑦ 生成调试签名…' -ForegroundColor Cyan
    $ErrorActionPreference = 'Continue'; & $KEYTOOL -genkeypair -keystore $KS -storepass android -keypass android -alias pcdebug `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=pc-dsh, OU=mobile-control, O=local, L=, ST=, C=CN" 2>&1 | Out-Null
}
Write-Host '⑧ 签名…' -ForegroundColor Cyan
& "$BT\apksigner.bat" sign --ks $KS --ks-pass pass:android --key-pass pass:android --ks-key-alias pcdebug `
    --out $Out "$Build\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }

& "$BT\apksigner.bat" verify --print-certs $Out 2>&1 | Select-Object -First 3 | ForEach-Object { "   $_" }
Write-Host "✅ 完成: $Out  ($([int]((Get-Item $Out).Length/1KB))KB)" -ForegroundColor Green
