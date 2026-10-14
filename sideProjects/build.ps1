param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$JavaDirectory = $env:JAVA_HOME
)

$ErrorActionPreference = 'Stop'
if (-not $AndroidSdk) { throw 'Set ANDROID_HOME or pass -AndroidSdk.' }
if (-not $JavaDirectory) { throw 'Set JAVA_HOME or pass -JavaDirectory (JDK 17).' }
$env:ANDROID_HOME = $AndroidSdk
$env:JAVA_HOME = $JavaDirectory
Push-Location $PSScriptRoot
try {
    & .\gradlew.bat :app:assembleRelease :app:lintRelease --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Release build or lint failed.' }
    $signer = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'build-tools') -Directory |
        Sort-Object { [version]($_.Name -replace '-.*$', '') } -Descending |
        ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $signer) { throw 'Android build-tools apksigner was not found.' }
    $apk = Join-Path $PSScriptRoot 'app\build\outputs\apk\release\app-release.apk'
    & $signer verify --verbose --print-certs $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $releaseDirectory = Join-Path $PSScriptRoot 'releases'
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    $output = Join-Path $releaseDirectory 'DogeDownloader-1.0.apk'
    Copy-Item -LiteralPath $apk -Destination $output -Force
    $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$output.sha256" -Value "$hash  DogeDownloader-1.0.apk" -Encoding ascii
    Write-Output $output
} finally {
    Pop-Location
}
