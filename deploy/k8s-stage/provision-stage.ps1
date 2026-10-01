Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profile = 'brickview-admin'
$region = 'us-east-1'
$context = 'brickview-stage-verified'
$namespace = 'kleenbay-stage'
$pod = 'kleenbay-db-admin-temporary'
$instance = 'brickview-postgres-stage'

function New-Password {
  return [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Invoke-RdsSql([string]$database, [string]$username, [string]$password, [string]$sql) {
  $connection = "host=$rdsHost port=5432 dbname=$database user=$username sslmode=verify-full sslrootcert=/tmp/rds-ca.pem"
  $result = ($password + "`n" + $sql + "`n") | & kubectl --context $context -n $namespace exec -i $pod -- sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql "$1" -v ON_ERROR_STOP=1 -At' sh $connection
  if ($LASTEXITCODE -ne 0) { throw "RDS SQL failed in $database as $username" }
  return $result
}

function Create-DatabaseSecret([string]$name, [string]$username, [string]$password) {
  $url = 'postgresql://{0}:{1}@{2}:5432/kleenbay_stage?sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Fus-east-1-bundle.pem' -f $username, $password, $rdsHost
  $manifest = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{ name = $name; namespace = $namespace }
    type = 'Opaque'
    stringData = @{ DATABASE_URL = $url }
  } | ConvertTo-Json -Depth 5 -Compress
  $manifest | & kubectl --context $context apply -f -
  if ($LASTEXITCODE -ne 0) { throw "Failed to create $name" }
}

$account = & aws sts get-caller-identity --profile $profile --query Account --output text
if ($LASTEXITCODE -ne 0 -or $account -ne '208519604276') { throw 'Unexpected AWS account' }

$dbInfo = & aws rds describe-db-instances --db-instance-identifier $instance --region $region --profile $profile --query 'DBInstances[0].{Host:Endpoint.Address,Username:MasterUsername,SecretArn:MasterUserSecret.SecretArn,Status:DBInstanceStatus}' --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $dbInfo.Status -ne 'available' -or $dbInfo.Username -ne 'brickview_stage_admin' -or -not $dbInfo.SecretArn) {
  throw 'Unexpected RDS instance metadata'
}
$rdsHost = $dbInfo.Host

$phase = & kubectl --context $context -n $namespace get pod $pod -o jsonpath='{.status.phase}'
if ($LASTEXITCODE -ne 0 -or $phase -ne 'Running') { throw 'Temporary DB admin pod is not running' }
& kubectl --context $context -n $namespace exec $pod -- test -s /tmp/rds-ca.pem
if ($LASTEXITCODE -ne 0) { throw 'RDS CA bundle is missing from temporary pod' }

foreach ($name in @('kleenbay-stage-api-db', 'kleenbay-stage-migrator-db')) {
  $existing = & kubectl --context $context -n $namespace get secret $name --ignore-not-found -o name
  if ($LASTEXITCODE -ne 0 -or $existing) { throw "Secret $name already exists; refusing to rotate it" }
}

$raw = & aws secretsmanager get-secret-value --secret-id $dbInfo.SecretArn --region $region --profile $profile --query SecretString --output text
if ($LASTEXITCODE -ne 0) { throw 'Could not read managed RDS master secret' }
$master = $raw | ConvertFrom-Json
$raw = $null
if ($master.username -ne $dbInfo.Username -or -not $master.password) { throw 'Unexpected RDS master secret' }

$preflight = Invoke-RdsSql 'postgres' $master.username $master.password "SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN ('kleenbay_stage_app','kleenbay_stage_migrator')), (SELECT count(*) FROM pg_database WHERE datname = 'kleenbay_stage');"
if (($preflight | Select-Object -Last 1) -ne '0|0') { throw 'Stage database or role already exists; refusing to overwrite' }

$appPassword = New-Password
$migratorPassword = New-Password
$createSql = @"
CREATE ROLE kleenbay_stage_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 3 PASSWORD '$migratorPassword';
CREATE ROLE kleenbay_stage_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20 PASSWORD '$appPassword';
CREATE DATABASE kleenbay_stage OWNER kleenbay_stage_migrator TEMPLATE template0 ENCODING 'UTF8';
"@
Invoke-RdsSql 'postgres' $master.username $master.password $createSql | Out-Null
$master = $null

$grantSql = @'
REVOKE ALL ON DATABASE kleenbay_stage FROM PUBLIC;
GRANT CONNECT ON DATABASE kleenbay_stage TO kleenbay_stage_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kleenbay_stage_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kleenbay_stage_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO kleenbay_stage_app;
'@
Invoke-RdsSql 'kleenbay_stage' 'kleenbay_stage_migrator' $migratorPassword $grantSql | Out-Null

Create-DatabaseSecret 'kleenbay-stage-api-db' 'kleenbay_stage_app' $appPassword
Create-DatabaseSecret 'kleenbay-stage-migrator-db' 'kleenbay_stage_migrator' $migratorPassword
$appPassword = $null
$migratorPassword = $null

Write-Output 'Stage database, roles, and two separate Kubernetes secrets created. No credentials were printed.'
