# Im-Nobsidian Installer for Windows
# Usage: irm https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Write-Header {
    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║        Im-Nobsidian Installer          ║" -ForegroundColor Cyan
    Write-Host "  ║   Obsidian ↔ Notion Bidirectional Sync ║" -ForegroundColor Cyan
    Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Info    { param($msg) Write-Host "[info] " -NoNewline -ForegroundColor Blue; Write-Host $msg }
function Write-Success { param($msg) Write-Host "[ok] " -NoNewline -ForegroundColor Green; Write-Host $msg }
function Write-Warn    { param($msg) Write-Host "[warn] " -NoNewline -ForegroundColor Yellow; Write-Host $msg }
function Write-Err     { param($msg) Write-Host "[error] " -NoNewline -ForegroundColor Red; Write-Host $msg }

function Test-NodeVersion {
    try {
        $version = (node -v) -replace 'v', ''
        $major = [int]($version.Split('.')[0])
        if ($major -ge 20) {
            Write-Success "Node.js v$version detected"
            return $true
        } else {
            Write-Warn "Node.js v$version found, but 20+ required"
            return $false
        }
    } catch {
        return $false
    }
}

function Install-Node {
    Write-Info "Installing Node.js 22 LTS..."

    # Try winget first
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Using winget..."
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        return
    }

    # Try chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Info "Using Chocolatey..."
        choco install nodejs-lts -y
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        return
    }

    # Try scoop
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Info "Using Scoop..."
        scoop install nodejs-lts
        return
    }

    # Manual download
    Write-Info "Downloading Node.js installer..."
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $installerUrl = "https://nodejs.org/dist/v22.22.0/node-v22.22.0-$arch.msi"
    $installerPath = Join-Path $env:TEMP "node-installer.msi"

    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
    Write-Info "Running Node.js installer..."
    Start-Process msiexec.exe -ArgumentList "/i", $installerPath, "/quiet", "/norestart" -Wait
    Remove-Item $installerPath -Force

    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

function Install-ImNobsidian {
    Write-Info "Installing im-nobsidian..."

    try {
        $current = nobsi --version 2>$null
        if ($current) {
            Write-Warn "im-nobsidian $current already installed — upgrading..."
        }
    } catch {}

    npm install -g im-nobsidian

    try {
        $version = nobsi --version
        Write-Success "im-nobsidian $version installed"
    } catch {
        Write-Err "Installation failed. Try manually: npm install -g im-nobsidian"
        exit 1
    }
}

function Write-Done {
    Write-Host ""
    Write-Host "  Installation complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Getting started:" -ForegroundColor White
    Write-Host ""
    Write-Host "    # Go to your Obsidian vault" -ForegroundColor DarkGray
    Write-Host "    cd ~\your-obsidian-vault" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    # Set up Notion connection (interactive)" -ForegroundColor DarkGray
    Write-Host "    nobsi init" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    # Sync both ways" -ForegroundColor DarkGray
    Write-Host "    nobsi sync" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Other commands:" -ForegroundColor White
    Write-Host "    nobsi push      " -NoNewline; Write-Host "Obsidian → Notion" -ForegroundColor DarkGray
    Write-Host "    nobsi pull      " -NoNewline; Write-Host "Notion → Obsidian" -ForegroundColor DarkGray
    Write-Host "    nobsi status    " -NoNewline; Write-Host "Check sync status" -ForegroundColor DarkGray
    Write-Host "    nobsi watch     " -NoNewline; Write-Host "Auto-sync on file changes" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Need a Notion token?" -ForegroundColor White
    Write-Host "    https://www.notion.so/my-integrations"
    Write-Host ""
    Write-Host "  Docs:" -ForegroundColor White
    Write-Host "    https://github.com/JaylenAI/Im-Nobsidian"
    Write-Host ""
}

# --- Main ---
Write-Header

if (-not (Test-NodeVersion)) {
    Install-Node
    if (-not (Test-NodeVersion)) {
        Write-Err "Node.js installation failed."
        Write-Err "Install manually: https://nodejs.org"
        exit 1
    }
}

Install-ImNobsidian
Write-Done
