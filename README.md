# pi-plan-usage

[English](README.md) | [中文](README.zh-CN.md)

A [pi coding agent](https://github.com/earendil-works/pi) extension that queries your **Volcengine Ark Coding Plan / Agent Plan** quota usage and shows it right in the status bar.

## What it does

- `/show-usage [provider] [plan] [on|off] — toggle plan usage in the status bar (e.g. `/show-usage ark coding`)
- Status bar (right-aligned, dim grey): a 5-slot progress bar plus reset countdown for each quota window (`5h` / `d` / `w` / `m`)
- Auto-refresh every 2 minutes (configurable), only for the plans you enabled
- `query_usage` tool — lets the LLM query usage for you in conversation
- Multiple accounts supported

Status bar example:

```
C:5h ░░░░░·2h57m w █░░░░·2d m ███░░·2d | A:未订阅
```

- `C` = Coding Plan, `A` = Agent Plan
- `█` = used quota, `░` = remaining
- `·2h57m` = time until reset (week/month windows show days, e.g. `·2d`; within 24h they fall back to hours)

## Install

```bash
pi install git:github.com/sowyer666/pi-plan-usage
```

Or try it without installing:

```bash
pi -e git:github.com/sowyer666/pi-plan-usage
```

## Configure

1. Copy the template in the package directory to `config/volcengine.json`:

   ```bash
   cp config/ark.example.json config/ark.json
   ```

2. Fill in your Volcengine AccessKey (AK/SK):
   - Create one at [IAM console](https://console.volcengine.com/iam/keymanage)
   - For IAM sub-accounts, `AccessKeySelfManageAccess` and `ArkReadOnlyAccess` permissions are required
3. One account per entry; use the same AK/SK with different `planType` if one account holds both plans

```json
{
  "accounts": [
    { "label": "火山Coding", "planType": "coding", "accessKeyId": "AKLT...", "secretAccessKey": "..." },
    { "label": "火山Agent",  "planType": "agent",  "accessKeyId": "AKLT...", "secretAccessKey": "..." }
  ],
  "cacheTtlSeconds": 300,
  "refreshIntervalSeconds": 120
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `accounts` | — | Required. At least one account |
| `cacheTtlSeconds` | `300` | Query cache lifetime |
| `refreshIntervalSeconds` | `120` | Status bar auto-refresh interval |

## Usage

```bash
/show-usage ark coding   # toggle Volcengine Coding Plan
/show-usage ark agent    # toggle Volcengine Agent Plan
/show-usage all          # show everything
/show-usage off          # hide everything
/show-usage status       # current on/off state
```

Plans are independent (several can be on at once). Turning a plan **off** clears its cache; turning it **on** queries fresh data.

Or just ask the agent: *"query my Volcengine usage"* — it will call the `query_usage` tool.

## License

MIT
