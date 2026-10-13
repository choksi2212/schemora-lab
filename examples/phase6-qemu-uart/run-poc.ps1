$ErrorActionPreference = 'Stop'

$image = 'espressif/idf@sha256:05cbfc42ed2e987b8026722c15bf1d8523d3e4fd1b4ac04d2e4056f5e0918b99'

docker run --rm --network none --platform linux/amd64 `
  --mount "type=bind,source=$PSScriptRoot,target=/project" `
  --workdir /project `
  $image bash /project/run-poc.sh

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
