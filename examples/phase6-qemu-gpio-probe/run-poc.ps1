$ErrorActionPreference = 'Stop'

$image = 'schemora-phase6-qemu-gpio-probe:local'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dockerfile = Join-Path $PSScriptRoot 'Dockerfile'

docker build --platform linux/amd64 --file $dockerfile --tag $image $repoRoot
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$captureEvents = if ($env:SCHEMORA_CAPTURE_EVENTS -eq '1') { '1' } else { '0' }
docker run --rm --network none --platform linux/amd64 --env "SCHEMORA_CAPTURE_EVENTS=$captureEvents" $image
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
