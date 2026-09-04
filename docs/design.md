# pi-plan-usage 设计文档

> 状态：**已确认，待开发** · 产品版本：0.1.0（开发版）

## 1. 背景与目标

本插件是一个 **pi coding agent 插件**（[pi](https://github.com/earendil-works/pi)），用于查询**火山引擎方舟 Coding Plan / Agent Plan** 的**套餐额度**。

- pi 插件机制：pi 支持 TypeScript 扩展，可注册命令（`pi.registerCommand`）、边栏组件（`ctx.ui.setWidget`），以 pi 包（npm / git）形式分发安装。
- 用户在 pi 中编码时，可通过 `/show-usage` 开关在**边栏**查看套餐额度与重置时间，避免撞限额。
- 后期可能接入更多供应商，架构上做**通用多供应商抽象**。

## 2. 已确认的需求与决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 接口以官方实现为准 | 套餐额度快照：Coding Plan → `GetCodingPlanUsage`，Agent Plan → `GetAFPUsage`（官方 ark-cli 同款 OpenAPI，AK/SK 签名）；仅取**套餐额度**数据 |
| D2 | UI 形式 | **状态栏显示（每 2 分钟自动刷新，`refreshIntervalSeconds` 可调）**。`/show-usage [coding\|agent\|all]` 分别开关各套餐在底部状态栏（自定义 footer，单行紧凑格式）的显示；自动刷新绕过缓存强制查询；关闭时清缓存，再开即刷新 |
| D3 | 配置位置 | **插件目录下 `config/` 文件夹**，JSON 按平台建：先只有 `config/volcengine.json`，后续每供应商一个文件 |
| D4 | 数据范围 | 只要**套餐额度**（窗口用量 + 重置时间），不做推理用量明细 |

## 3. 总体架构

```
┌─────────────────────────────────────────────┐
│  pi 集成层（src/index.ts）                    │
│  - /show-usage 命令：参数开关各套餐的状态栏显示        │
├─────────────────────────────────────────────┤
│  供应商抽象层（src/providers/types.ts）        │
│  - UsageProvider 接口 + Provider 注册表       │
├─────────────────────────────────────────────┤
│  供应商实现层                                 │
│  - volcengine-ark（火山方舟，首个实现）        │
│  - 未来：其他供应商各一个文件                   │
└─────────────────────────────────────────────┘
```

### 3.1 供应商抽象接口

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
  /** 边栏多行展示 */
  formatWidget(snapshot: UsageSnapshot): string[];
}
```

新增供应商 = 实现一个 `UsageProvider` + 在 `config/` 下新增一个 JSON + 注册到 registry，pi 集成层代码零改动。

## 4. 火山方舟实现（首个 Provider）

### 4.1 官方接口

- **`GetCodingPlanUsage`（Coding Plan 套餐额度）** / **`GetAFPUsage`（Agent Plan 套餐额度）**
- 依据：火山官方 ark-cli 的 `usage plan` 底层接口（https://github.com/volcengine/ark-cli），返回 `periods`：`5h`/`session`、`weekly`、`monthly` 的 `used`/`total`/`percent`/`reset_at`；Coding Plan 为 `QuotaUsage` 数组（`Label/Level` + `Percent` + `UpdateTimestamp`）
- 网关：`https://open.volcengineapi.com`
- Service：`ark`，Version：`2024-01-01`，Region：`cn-beijing`
- 请求方式：火山引擎 OpenAPI 通用规范（V4 签名，HMAC-SHA256，空 POST）
- 响应字段解析做防御性兼容（大小写、秒/毫秒时间戳），`raw` 保留原始响应便于排查

### 4.2 凭证

- 需要**火山引擎 AccessKey（AK/SK）**，控制台 https://console.volcengine.com/iam/keymanage 创建
- 子账户需具备 `AccessKeySelfManageAccess` 和 `ArkReadOnlyAccess` 权限
- 不使用方舟 API Key（那是推理鉴权用的，管控面 OpenAPI 走 AK/SK）

### 4.3 查询逻辑

1. 按账号 `planType` 分发：`coding` → `GetCodingPlanUsage`；`agent` → `GetAFPUsage`
2. 归一化为 `UsageSnapshot`（窗口标签 `5h`/`session`/`weekly`/`monthly` + 用量/百分比 + 重置时间）
3. 不做推理用量明细统计（决策 D4）

## 5. pi 插件集成

### 5.1 包形态

以 **pi 包**分发（`pi install git:github.com/...` 或 npm），`package.json` 声明：

```json
{
  "name": "pi-plan-usage",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/index.ts"] }
}
```

### 5.2 交互设计（决策 D2：状态栏 + 参数开关）

| 能力 | 名称 | 说明 |
|------|------|------|
| 命令（核心） | `/show-usage [coding\|agent\|all]` | 分别开关各套餐在底部状态栏的显示；无参/`all` = 全部切换；**关闭时清该套餐缓存，再开 = 强制刷新** |
| 工具（次要） | `query_usage` | 供 LLM 调用，参数：`account?`（账号名，缺省查全部），返回文本快照 |

状态栏显示（`ctx.ui.setStatus`，单行紧凑格式，`C:` = Coding、`A:` = Agent）：

```
C:5h 4%·2h57m 周 27%·61h 月 57% | A:未订阅
```

- 自动刷新：session_start 启动定时器（默认 120s，`refreshIntervalSeconds` 可调），仅刷新已开启的套餐，绕过缓存；session_shutdown 清理定时器
- 状态栏显示（自定义 footer，第 3 行右对齐，dim 灰）：`C:5h ░░░░░·2h57m w █░░░░·2d m ███░░·2d | A:未订阅`
- 查询失败显示 `C:查询失败`（错误短缓存 30s 避免高频重试）

### 5.3 配置（决策 D3）

配置位于**插件目录下 `config/` 文件夹，按平台一个 JSON**，先只有火山：

```
config/
└── volcengine.json    # 火山账号配置（多账号）
```

`config/volcengine.json`：

```json
{
  "accounts": [
    {
      "label": "火山Coding",
      "planType": "coding",
      "accessKeyId": "AK...",
      "secretAccessKey": "SK..."
    },
    {
      "label": "火山Agent",
      "planType": "agent",
      "accessKeyId": "AK...",
      "secretAccessKey": "SK..."
    }
  ],
  "cacheTtlSeconds": 300
}
```

- 同一账号同时开通两种套餐时，两个条目填同一套 AK/SK，`planType` 不同即可
- 仓库提供 `config/volcengine.example.json` 模板，真实配置文件加入 `.gitignore`
- 后续新增供应商 = `config/<平台>.json` + 对应 provider 实现

### 5.4 缓存与错误处理

- 查询结果缓存（默认 5 分钟，`cacheTtlSeconds` 可调）
- 单账号查询失败不影响其他账号；错误信息带原因（签名失败/权限不足/网络超时）
- 所有请求支持 `AbortSignal`，随 pi 会话取消

## 6. 目录结构

```
pi-plan-usage/
├── AGENTS.md
├── docs/                            # 文档（本目录）
├── package.json
├── tsconfig.json
├── .gitignore                       # 忽略 config/volcengine.json
├── config/
│   ├── volcengine.example.json      # 配置模板（入库）
│   └── volcengine.json              # 真实配置（不入库，用户填写）
└── src/
    ├── index.ts                     # pi 扩展入口（/show-usage、widget、query_usage 工具）
    ├── config.ts                    # 配置加载与校验（按平台文件）
    ├── cache.ts                     # 用量缓存
    ├── format.ts                    # 快照格式化（边栏多行 / 文本）
    └── providers/
        ├── types.ts                 # UsageProvider 抽象 + registry
        └── volcengine-ark/
            ├── index.ts             # provider 实现
            ├── sign.ts              # V4 签名
            └── api.ts               # OpenAPI 调用（GetInferenceUsage）
```

## 7. 开发计划（每步一个 feat/ 分支，做完即提交）

| 阶段 | 分支 | 内容 |
|------|------|------|
| M1 | `feat/ark-provider` | 火山方舟 provider：V4 签名 + `GetCodingPlanUsage`/`GetAFPUsage` 查询 + 归一化，CLI 脚本可独立跑通 |
| M2 | `feat/show-usage` | pi 扩展入口：`/show-usage` 开关命令 + 边栏 widget + `query_usage` 工具 |
| M3 | 按需 | 后续供应商接入（暂不做） |

## 8. 变更记录

版本跟随产品版本（见 AGENTS.md 版本规范），不设独立文档版本。

- **0.1.0**：初版——火山方舟 provider（`GetCodingPlanUsage`/`GetAFPUsage` 查询套餐额度）；`/show-usage [coding|agent|all]` 状态栏显示开关（5 格进度条 + 分级时间格式，右对齐，2 分钟自动刷新）+ `query_usage` 工具；配置在插件目录 `config/` 按平台建 JSON。
