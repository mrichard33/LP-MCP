#Requires -Version 5.1
<#
.SYNOPSIS
  Verify that LP MCP accepts Slack-signed interactivity requests.

.DESCRIPTION
  The Slack signing secret CANNOT be generated locally. Slack issues it when the
  app is created, and both sides must hold the same value: Slack signs each
  request with it, LP MCP verifies with it. A locally-invented string would make
  every click fail with 401.

  So this script does the useful thing instead: it proves the secret you put in
  Railway is the same one Slack is using, by signing a request exactly the way
  Slack does and checking LP MCP accepts it.

  THE PROBE CHANGES NOTHING. It uses our own action_id (so it is never relayed
  to the n8n onboarding workflow), a short_ref that does not exist, and no
  response_url. Worst case it resolves to "no pending approval".

.PARAMETER SigningSecret
  From api.slack.com/apps -> Reece Bot -> Basic Information -> Signing Secret.

.EXAMPLE
  .\Test-SlackInteractivity.ps1 -SigningSecret 'abc123...'
#>
param(
  [Parameter(Mandatory = $true)][string]$SigningSecret,
  [string]$Url = 'https://lp-mcp-production.up.railway.app/webhook/slack/interactions'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Built as a literal so the bytes we sign are exactly the bytes we send.
# ConvertTo-Json is avoided on purpose: in Windows PowerShell it can collapse a
# single-element array, which would change the body after signing.
$payloadJson = '{"type":"block_actions","user":{"id":"U_PROBE","name":"probe"},"message":{"text":"connectivity probe"},"actions":[{"action_id":"approval_approve","value":"999999999"}]}'
$body = 'payload=' + [System.Uri]::EscapeDataString($payloadJson)

function New-SlackSignature {
  param([string]$Secret, [string]$Timestamp, [string]$Payload)
  $base = 'v0:' + $Timestamp + ':' + $Payload
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  try {
    $hmac.Key = [Text.Encoding]::UTF8.GetBytes($Secret)
    $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($base))
  } finally { $hmac.Dispose() }
  'v0=' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
}

function Invoke-Probe {
  param([string]$Label, [hashtable]$Headers, [int]$Expected)
  $status = 0
  try {
    $resp = Invoke-WebRequest -Uri $Url -Method Post -Body $body `
      -ContentType 'application/x-www-form-urlencoded' `
      -Headers $Headers -UseBasicParsing -TimeoutSec 20
    $status = [int]$resp.StatusCode
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  } catch {
    # PowerShell 7 surfaces HTTP errors as HttpResponseException.
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
    } else { throw }
  }
  [pscustomobject]@{
    Test     = $Label
    Expected = $Expected
    Got      = $status
    Result   = if ($status -eq $Expected) { 'PASS' } else { 'FAIL' }
  }
}

$ts      = [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$goodSig = New-SlackSignature -Secret $SigningSecret -Timestamp $ts -Payload $body
$badSig  = New-SlackSignature -Secret 'not-the-real-secret' -Timestamp $ts -Payload $body

Write-Host "`nProbing $Url`n" -ForegroundColor Cyan

$results = @(
  Invoke-Probe -Label 'Correctly signed' -Expected 200 -Headers @{
    'X-Slack-Request-Timestamp' = $ts; 'X-Slack-Signature' = $goodSig
  }
  Invoke-Probe -Label 'No signature headers' -Expected 401 -Headers @{}
  Invoke-Probe -Label 'Signed with a wrong secret' -Expected 401 -Headers @{
    'X-Slack-Request-Timestamp' = $ts; 'X-Slack-Signature' = $badSig
  }
)

$results | Format-Table -AutoSize

$unsigned = ($results | Where-Object { $_.Test -eq 'No signature headers' }).Got
if ($unsigned -eq 200) {
  Write-Host 'INCONCLUSIVE: the unsigned request was accepted, which means the route is' -ForegroundColor Yellow
  Write-Host 'short-circuiting before it checks anything (approvals off AND no forward URL).' -ForegroundColor Yellow
  Write-Host 'Set SLACK_INTERACTIONS_FORWARD_URL, redeploy, then run this again.' -ForegroundColor Yellow
  exit 2
}

if ($results.Result -contains 'FAIL') {
  Write-Host 'FAILED. A 401 on the signed request means the secret in Railway does not' -ForegroundColor Red
  Write-Host 'match the one Slack is using. Re-copy it from Basic Information.' -ForegroundColor Red
  exit 1
}

Write-Host 'All checks passed. The secret in Railway matches Slack, and unsigned' -ForegroundColor Green
Write-Host 'requests are refused. Safe to repoint the Slack Interactivity URL.' -ForegroundColor Green
exit 0
