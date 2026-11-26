#requires -Version 7.3
param([ValidateSet('install','serve','connect','stop')][string]$Action = 'install')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'InterviewPrep' 'inference'
$file = Join-Path $cache 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
$keyFile = Join-Path $cache 'server.key'
$owner = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($cache))).Substring(0,12).ToLowerInvariant()
$name = "interview-prep-model-$owner"
$port = 5191
$runtime = 'ghcr.io/ggml-org/llama.cpp'
$context = (docker context inspect --format '{{.Endpoints.docker.Host}}').Trim()
if ($context -notmatch '^(npipe:|unix:)' -or ($env:DOCKER_HOST -and $env:DOCKER_HOST -notmatch '^(npipe:|unix:)')) { throw 'Select a local Docker engine; private model files must never be mounted on a remote daemon.' }
$image = switch ((docker version --format '{{.Server.Arch}}').Trim()) {
    'arm64' { "${runtime}@sha256:545e22031f2f4823b95496586104b082e69b3d1852fdb9d973e24502f3fc1512" }
    'amd64' { "${runtime}@sha256:8088e24a4a458a35eea1b6b9e9c333876da2a0cf4c77ca8e79fcab7cc4a097c8" }
    default { throw 'Use an explicit trusted OpenAI-compatible model server on this architecture.' }
}
$exists = @((docker container ls -a --filter "name=^/$name$" --format '{{.Names}}')) -contains $name
if ($exists) {
    $spec = (docker inspect $name | ConvertFrom-Json)[0]
    if ($spec.Config.Labels.'org.interview-prep.owner' -ne $owner -or $spec.Config.Image -ne $image -or
        $spec.HostConfig.PortBindings.'8080/tcp'[0].HostIp -ne '127.0.0.1' -or $spec.HostConfig.PortBindings.'8080/tcp'[0].HostPort -ne "$port") {
        throw 'A different container uses the model name; it was not changed.'
    }
}
if ($Action -eq 'install') {
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $sha = '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
    if (!(Test-Path -LiteralPath $file)) {
        $uri = 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf'
        $curl = (Get-Command curl -CommandType Application | Select-Object -First 1).Source
        & $curl --fail --location --silent --show-error --retry 2 -o "$file.partial" $uri
        if ((Get-FileHash -LiteralPath "$file.partial").Hash -ne $sha) { throw 'Model checksum mismatch. No model installed.' }
        Move-Item -LiteralPath "$file.partial" -Destination $file
    }
    if ((Get-FileHash -LiteralPath $file).Hash -ne $sha) { throw 'The model weights do not match the pinned official release.' }
    if (!(Test-Path -LiteralPath $keyFile)) {
        $stream = [IO.File]::Open($keyFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write([Text.Encoding]::ASCII.GetBytes([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))) } finally { $stream.Dispose() }
        if (!$IsWindows) { [IO.File]::SetUnixFileMode($keyFile, [IO.UnixFileMode]'UserRead,UserWrite') }
    }
    if (!$exists) {
        docker pull --quiet $image | Out-Null
        docker create --name $name --label "org.interview-prep.owner=$owner" --publish "127.0.0.1:${port}:8080" --log-driver none `
            --cpus 3 --memory 2100m --memory-swap 2100m --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp `
            --mount "type=bind,source=$file,target=/model.gguf,readonly" --mount "type=bind,source=$keyFile,target=/run/model-key,readonly" `
            $image -m /model.gguf --alias studio-qwen2.5-1.5b --host 0.0.0.0 --port 8080 --api-key-file /run/model-key `
            --threads 3 --threads-batch 3 --parallel 1 --ctx-size 6144 --no-webui --log-disable | Out-Null
    }
    Write-Host 'Local Qwen model installed. dev.ps1 up will connect it.'
    return
}
if (!$exists) { throw 'The studio model is not installed. Run scripts\model.ps1 install first.' }
if ($Action -eq 'stop') { docker stop $name | Out-Null; return }
if (!$spec.State.Running) {
    if ($Action -eq 'serve') { docker start --attach $name; return }
    docker start $name | Out-Null
}
$headers = @{Authorization="Bearer $([IO.File]::ReadAllText($keyFile).Trim())"}
$ready = $false
for ($attempt = 0; $attempt -lt 180; $attempt++) {
    try { $models = Invoke-RestMethod "http://127.0.0.1:$port/v1/models" -NoProxy -Headers $headers -TimeoutSec 2
        if ($models.data.id -contains 'studio-qwen2.5-1.5b') { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if (!$ready) { throw 'The installed model did not become ready. Check Docker resources and the local port.' }
$env:INTERVIEW_PREP_MODEL_PORT="$port"
$env:INTERVIEW_PREP_MODEL_KEY_FILE=$keyFile
$env:INTERVIEW_PREP_MODEL_ID='studio-qwen2.5-1.5b'
Write-Host "Connected to the local Qwen model on port $port."
