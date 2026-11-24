param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')]
  [string]$IpAddress,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$certDirectory = Join-Path $PSScriptRoot "certs"
New-Item -ItemType Directory -Force -Path $certDirectory | Out-Null

$rootKey = Join-Path $certDirectory "rootCA.key"
$rootCert = Join-Path $certDirectory "rootCA.crt"
$serverKey = Join-Path $certDirectory "server.key"
$serverRequest = Join-Path $certDirectory "server.csr"
$serverCert = Join-Path $certDirectory "server.crt"
$extensions = Join-Path $certDirectory "server.ext"

if ((Test-Path $rootKey) -ne (Test-Path $rootCert)) {
  throw "The local CA is incomplete. Restore both rootCA.key and rootCA.crt before continuing."
}

if (-not (Test-Path $rootKey)) {
  & openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 `
    -keyout $rootKey -out $rootCert `
    -subj "/CN=Elawini Estate MeetVote Local CA" `
    -addext "basicConstraints=critical,CA:TRUE" `
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed to create the local CA." }
}

if ((Test-Path $serverKey) -or (Test-Path $serverCert)) {
  if (-not $Force) {
    throw "A server certificate already exists. Use -Force to renew it while keeping the trusted local CA."
  }
  Remove-Item -LiteralPath $serverKey, $serverCert -ErrorAction SilentlyContinue
}

& openssl req -new -newkey rsa:2048 -nodes `
  -keyout $serverKey -out $serverRequest -subj "/CN=$IpAddress"
if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed to create the server certificate request." }

@"
subjectAltName = IP:$IpAddress
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
"@ | Set-Content -Encoding ascii $extensions

& openssl x509 -req -in $serverRequest -CA $rootCert -CAkey $rootKey `
  -CAcreateserial -out $serverCert -days 365 -sha256 -extfile $extensions
if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed to sign the server certificate." }

Remove-Item -LiteralPath $serverRequest, $extensions, (Join-Path $certDirectory "rootCA.srl") `
  -ErrorAction SilentlyContinue
Write-Host "Created a local certificate for $IpAddress in $certDirectory"
Write-Host "Install rootCA.crt on each device that will access MeetVote."
