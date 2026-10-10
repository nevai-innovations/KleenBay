# Controlled Stage WhatsApp Connection

This rollout does not enable MSG91 for all tenants. Keep the stage ConfigMap's
`MESSAGING_PROVIDER=mock`. A provisioned organization's database configuration
selects MSG91; all unconfigured stage organizations continue using MOCK.
Local development still uses `MESSAGING_PROVIDER=mock` without credentials.

## Backend Credential

Dedicated namespace: `kleenbay-stage`. Secret: `kleenbay-stage-whatsapp`.
Only key: `MSG91_WHATSAPP_AUTH_KEYS_JSON`.
Its JSON maps `<organizationId>:primary` to that tenant's WhatsApp AuthKey.
Do not reuse the OTPWidget AuthKey; WhatsApp needs its own provider permissions.
Never put credentials in a ConfigMap, source, documentation, or browser response.

PowerShell example, with the selected non-secret organization ID supplied by the
operator. Input is hidden and the Secret is piped directly to Kubernetes; neither
the AuthKey nor the generated manifest is printed or saved to disk:

```powershell
$context = 'brickview-stage-verified'
$organizationId = Read-Host 'Controlled stage organization ID'
$secure = Read-Host 'Dedicated MSG91 WhatsApp AuthKey' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $secure)
$mapping = @{}
$mapping["${organizationId}:primary"] = $credential.Password
$manifest = @{
  apiVersion = 'v1'; kind = 'Secret'
  metadata = @{ name = 'kleenbay-stage-whatsapp'; namespace = 'kleenbay-stage' }
  type = 'Opaque'
  stringData = @{ MSG91_WHATSAPP_AUTH_KEYS_JSON = ($mapping | ConvertTo-Json -Compress) }
} | ConvertTo-Json -Depth 8 -Compress
$manifest | kubectl --context $context -n kleenbay-stage apply -f -
Remove-Variable manifest, mapping, credential, secure
```

Do not run this with PowerShell transcription/debug output enabled. The existing
Secret must be inspected by key name first; this single-tenant setup intentionally
does not merge credentials for additional real tenants. API needs a rollout after
the Secret changes. A missing optional Secret means no real connectivity, never a
fallback real send or fabricated Connected state.

## Sender And Templates

Provision only the selected synthetic QA tenant using
`deploy/k8s-stage/provision-whatsapp-sender.mjs`, piped to the stage API pod's
`node --input-type=module - <organizationId>`. The script checks namespace,
environment, database, origin, and the QA organization's name/slug.

- Sender: `+918137994052`
- Display name: `NevAi`
- Received: `kb_vehicle_received`
- Washing: `kb_wash_started`
- Ready: `kb_vehicle_ready`
- Handover: null (no message)

The script resets connection/approval verification; do not rerun after successful
verification unless deliberately reprovisioning. No real message is sent by it.

## Verify Without Sending

Owner opens Settings > WhatsApp > Test connection. Backend uses the official
read-only MSG91 endpoints:

- [Fetch WhatsApp numbers](https://docs.msg91.com/whatsapp/to-fetch-whatsapp-number)
- [Get templates](https://docs.msg91.com/whatsapp/get-templates)

The configured sender must be returned by the authenticated account. Connection
verification never calls a send endpoint. Template states are returned separately;
unknown/unavailable results are explicitly UNKNOWN and do not imply approval.
Only verified APPROVED templates may be dispatched. Changing templates clears
verification. Re-run Test connection after Meta approval.

## Controlled Handset Test

Do not perform real sends before all three templates show APPROVED and the test
recipient has consented. Use a synthetic customer/job and an opted-in real handset.
Check in, advance to WASHING, then READY. Check the actual handset after each event.
Variables are `[customer name, vehicle registration, business name, tracking URL]`;
the same private job tracking link is reused. Handover has no configured template.
The selected organization must have customer tracking links enabled.

Message SENT means **provider accepted**, not confirmed handset delivery. There is
no delivery-receipt integration in this milestone. A unique job/event prevents
duplicate logical notifications; network timeouts can still leave ambiguous remote
acceptance, so do not claim exactly-once handset delivery. Manual retries preserve
attempt history and do not change workflow history.

Employees cannot access settings/connection/retry controls. Employee job DTOs expose
basic event/status timestamps only, not recipient, payload, provider credentials,
financial data or delivery-attempt internals.

## Rollout

Apply migration `20261010200000_whatsapp_template_statuses` to `kleenbay_stage`
using the existing migrator secret, then roll out verified API/web images.
Check both deployments ready and internal `/health` and `/ready` return 200.
No production resources, BrickView configuration, or unrelated tenant settings
may be changed.
