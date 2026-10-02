$ErrorActionPreference = 'Stop'

$root = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Run this from a KleenBay Git checkout.' }

Push-Location $root
try {
    git fetch origin main
    if ($LASTEXITCODE -ne 0) { throw 'Could not refresh origin/main; deployment stopped.' }

    $branch = (git branch --show-current).Trim()
    if ($branch -ne 'main') { throw "Deployment requires the main branch; current branch: $branch" }

    $changes = git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0) { throw 'Could not check the working tree.' }
    if ($changes) { throw 'Deployment requires a clean working tree. Commit and push application changes first.' }

    $head = (git rev-parse HEAD).Trim()
    $remote = (git rev-parse origin/main).Trim()
    if ($head -ne $remote) { throw 'Local main is not identical to origin/main. Pull or push the latest verified code first.' }

    Write-Host "KleenBay release source verified: main $head"
} finally {
    Pop-Location
}
