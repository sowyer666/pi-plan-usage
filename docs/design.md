# pi-volcengine-usage 设计文档

> 状态：**待确认**（确认后才开始开发）

## 1. 背景与目标

本插件是一个 **pi coding agent 插件**（[pi](https://github.com/earendil-works/pi)），用于查询**火山引擎方舟 Coding Plan / Agent Plan** 的套餐用量。

- pi 插件机制：pi 支持 TypeScript 扩展，可注册工具（`pi.registerTool`）、命令（`pi.registerCommand`）、状态栏状态（`ctx.ui.setStatus` / `setWidget`），以 pi 包（npm / git）形式分发安装。
- 用户在 pi 中编码时，可随时查看当前套餐的额度消耗与重置时间，避免撞限额。
- 后期可能接入更多供应商（如其他云厂商的套餐用量），因此**架构上做通用多供应商抽象**。

## 2. 需求

| # | 需求 | 说明 |
|---|------|------|
| 1 | 查询火山 Coding Plan / Agent Plan 用量 | 套餐窗口额度（5 小时窗口、周、月）、重置倒计时 |
| 2 | pi 插件形态 | 注册工具 + 命令，可在对话中查询、可在状态栏展示 |
| 3 | 通用多供应商架构 | 供应商抽象接口，火山方舟是第一个实现，后续可扩展 |
| 4 | 多账号支持 | 支持配置多组凭证（如同时有 Coding Plan 和 Agent Plan 两个账号） |

非目标（当前阶段）：网页 UI、用量历史趋势图、多供应商竞价路由。

## 3. 总体架构

### 3.1 分层

```
┌─────────────────────────────────────────────┐
│  pi 集成层（src/index.ts）                    │
│  - /usage 命令、query_usage 工具、状态栏       │
├─────────────────────────────────────────────┤
│  供应商抽象层（src/providers/types.ts）        │
│  - UsageProvider 接口 + Provider 注册表       │
├─────────────────────────────────────────────┤
│  供应商实现层                                 │
│  - volcengine-ark（火山方舟，首个实现）        │
│  - 未来：其他供应商各一个文件                   │
└─────────────────────────────────────────────┘
```

### 3.2 供应商抽象接口

```typescript
/** 通用用量快照：所有供应商查询结果都归一化为此结构 */
interface UsageSnapshot {
  providerId: string;          // "volcengine-ark"
  accountLabel: string;        // 账号显示名（配置中自定义）
  planType: string;            // "coding" | "agent" | ...
  windows: UsageWindow[];      // 各额度窗口
  fetchedAt: string;           // ISO 时间
  raw?: unknown;               // 保留原始响应，便于排查
}

/** 额度窗口：5小时 / 周 / 月等 */
interface UsageWindow {
  kind: "rolling5h" | "weekly" | "monthly" | "other";
  label: string;               // 展示名
  used?: number;
  remaining?: number;
  total?: number;
  resetAt?: string;            // ISO 重置时间
}

/** 供应商接口 */
interface UsageProvider {
  id: string;                          // "volcengine-ark"
  displayName: string;                 // "火山方舟"
  /** 校验并解析该供应商的凭证配置 */
  parseCredential(config: ProviderAccountConfig): Credential;
  /** 查询用量（快照） */
  queryUsage(cred: Credential, signal?: AbortSignal): Promise<UsageSnapshot>;
  /** 单行摘要（状态栏用），如 "火山Coding 5h: 320/1200 · 4h12m 重置" */
  formatSummary(snapshot: UsageSnapshot): string;
}
```

新增供应商 = 实现一个 `UsageProvider` + 注册到 registry，pi 集成层代码零改动。

## 4. 火山方舟实现（首个 Provider）

### 4.1 官方接口（以官方文档为准）

| 用途 | 接口 | 官方文档 |
|------|------|----------|
| 查询推理用量 | `GetInferenceUsage` | https://docs.volcengine.com/docs/82379/2116766?lang=zh |
| 获取套餐用量详情 | `GetUsageDetails` | https://docs.volcengine.com/docs/82379/2479849?lang=zh |

- 网关：`https://open.volcengineapi.com`
- Service：`ark`，Version：`2024-01-01`，Region：`cn-beijing`
- 请求方式：火山引擎 OpenAPI 通用规范（V4 签名，HMAC-SHA256）
- ⚠️ 具体请求参数与响应字段**以官方文档为准**（文档站为动态渲染，本设计阶段未抓取到正文；开发时以文档正文/控制台调试为准，不臆造字段）

### 4.2 凭证

- 需要**火山引擎 AccessKey（AK/SK）**，控制台 https://console.volcengine.com/iam/keymanage 创建
- 子账户需具备 `AccessKeySelfManageAccess` 和 `ArkReadOnlyAccess` 权限
- 不使用方舟 API Key（那是推理鉴权用的，管控面 OpenAPI 走 AK/SK）

### 4.3 查询逻辑

1. 根据配置的套餐类型（`coding` / `agent`）调用 `GetUsageDetails` 获取套餐窗口额度（5h / 周 / 月、剩余次数、重置时间）
2. 可选调用 `GetInferenceUsage` 获取推理用量明细（按模型/时间聚合）
3. 归一化为 `UsageSnapshot` 返回

## 5. pi 插件集成

### 5.1 包形态

以 **pi 包**分发（`pi install git:github.com/...` 或 npm），`package.json` 声明：

```json
{
  "name": "pi-volcengine-usage",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/index.ts"] }
}
```

### 5.2 注册能力

| 能力 | 名称 | 说明 |
|------|------|------|
| 命令 | `/usage` | 交互式查看用量：选择账号 → 展示各窗口额度与重置倒计时 |
| 工具 | `query_usage` | 供 LLM 调用，参数：`account?`（账号名，缺省查全部） |
| 状态栏 | `ctx.ui.setStatus` | 查询后显示单行摘要；**默认不自动轮询**（避免频繁请求） |

### 5.3 配置

配置文件 `~/.pi/agent/volcengine-usage.json`（插件自行读取，多账号数组）：

```json
{
  "accounts": [
    {
      "label": "火山Coding",
      "provider": "volcengine-ark",
      "planType": "coding",
      "accessKeyId": "AK",
      "secretAccessKey": "SK"
    },
    {
      "label": "火山Agent",
      "provider": "volcengine-ark",
      "planType": "agent",
      "accessKeyId": "AK",
      "secretAccessKey": "SK"
    }
  ],
  "cacheTtlSeconds": 300
}
```

- `secretAccessKey` 也可用环境变量占位（如 `$VOLC_SECRET_KEY`），避免明文落盘
- `provider` 字段对应供应商 id，新增供应商时用户只需换这个字段和凭证字段

### 5.4 缓存与错误处理

- 查询结果缓存（默认 5 分钟），状态栏/连续查询不重复打 API
- 单账号查询失败不影响其他账号；错误信息带原因（签名失败/权限不足/网络超时）
- 所有请求支持 `AbortSignal`，随 pi 会话取消

## 6. 目录结构

```
pi-volcengine-usage/
├── AGENTS.md
├── docs/                    # 文档（本目录）
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts             # pi 扩展入口（命令/工具/状态栏）
    ├── config.ts            # 配置加载与校验
    ├── providers/
    │   ├── types.ts         # UsageProvider 抽象 + registry
    │   └── volcengine-ark/  # 火山方舟实现
    │       ├── index.ts     # provider 实现
    │       ├── sign.ts      # V4 签名
    │       └── api.ts       # OpenAPI 调用（GetUsageDetails / GetInferenceUsage）
    └── format.ts            # 快照格式化（状态栏/表格输出）
```

## 7. 开发计划（每步一个 feat/ 分支）

| 阶段 | 分支 | 内容 |
|------|------|------|
| M1 | `feat/ark-provider` | 火山方舟 provider：V4 签名 + GetUsageDetails 查询 + 归一化，CLI 可独立跑通 |
| M2 | `feat/pi-integration` | pi 扩展入口：/usage 命令 + query_usage 工具 |
| M3 | `feat/statusbar` | 状态栏摘要展示 + 缓存 |
| M4 | 按需 | 推理用量明细（GetInferenceUsage）、更多供应商 |

## 8. 待确认问题

1. **接口字段**：官方文档站动态渲染抓不到正文，开发 M1 时以文档正文为准。若你能把 `GetUsageDetails` 页面内容贴给我（或允许我后续从其他途径获取），可提前锁定字段。
2. **状态栏是否需要自动刷新**？本设计默认手动查询（/usage 或让 LLM 调工具），自动轮询会增加 API 压力。
3. **配置文件位置**：放 `~/.pi/agent/volcengine-usage.json` 是否可以？还是你希望用环境变量为主？
4. **是否需要推理用量明细**（按模型/时间的 Token 统计），还是只要套餐额度即可？
