# pi-plan-usage

[English](README.md) | [中文](README.zh-CN.md)

一个 [pi coding agent](https://github.com/earendil-works/pi) 插件：查询**火山引擎方舟 Coding Plan / Agent Plan** 的套餐用量，显示在底部状态栏。

## 功能

- `/show-usage [coding|agent|all]` — 分别开关 Coding Plan / Agent Plan 在状态栏的显示
- 状态栏（右对齐、灰色）：每个额度窗口一条 5 格进度条 + 重置倒计时（`5h` / `d` / `w` / `m`）
- 每 2 分钟自动刷新（可配置），只刷新已开启的套餐
- `query_usage` 工具 — 可在对话中让 LLM 帮你查用量
- 支持多账号

状态栏效果：

```
C:5h ░░░░░·2h57m w █░░░░·2d m ███░░·2d | A:未订阅
```

- `C` = Coding Plan，`A` = Agent Plan
- `█` = 已用量，`░` = 剩余
- `·2h57m` = 距离重置的时间（周/月窗口只显示天数如 `·2d`，不足 24 小时才显示小时）

## 安装

```bash
pi install git:github.com/sowyer666/pi-plan-usage
```

或不安装直接试用：

```bash
pi -e git:github.com/sowyer666/pi-plan-usage
```

## 配置

1. 把插件目录下的模板复制为 `config/volcengine.json`：

   ```bash
   cp config/volcengine.example.json config/volcengine.json
   ```

2. 填入火山引擎 AccessKey（AK/SK）：
   - 在 [IAM 控制台](https://console.volcengine.com/iam/keymanage) 创建
   - 子账户需具备 `AccessKeySelfManageAccess` 和 `ArkReadOnlyAccess` 权限
3. 每个账号一条记录；同一账号同时有两种套餐时，填同一套 AK/SK、不同的 `planType` 即可

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

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `accounts` | — | 必填，至少一个账号 |
| `cacheTtlSeconds` | `300` | 查询结果缓存时长（秒） |
| `refreshIntervalSeconds` | `120` | 状态栏自动刷新间隔（秒） |

## 使用

```bash
/show-usage coding   # 开/关 Coding Plan 状态栏显示
/show-usage agent    # 开/关 Agent Plan
/show-usage all      # 全部切换
```

关闭某个套餐会清掉它的缓存；再打开时会查询最新数据。

也可以直接对 agent 说："帮我查一下火山用量" — 它会调用 `query_usage` 工具。

## License

MIT
