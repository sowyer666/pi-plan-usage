# pi-volcengine-usage 设计文档

> 状态：**v2 · 已按用户确认意见修订**（2026-02）

## 1. 背景与目标

本插件是一个 **pi coding agent 插件**（[pi](https://github.com/earendil-works/pi)），用于查询**火山引擎方舟 Coding Plan / Agent Plan** 的**套餐额度**。

- pi 插件机制：pi 支持 TypeScript 扩展，可注册命令（`pi.registerCommand`）、边栏组件（`ctx.ui.setWidget`），以 pi 包（npm / git）形式分发安装。
- 用户在 pi 中编码时，可通过 `/show-usage` 开关在**边栏**查看套餐额度与重置时间，避免撞限额。
- 后期可能接入更多供应商，架构上做**通用多供应商抽象**。

## 2. 已确认的需求与决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 接口以官方文档为准 | https://docs.volcengine.com/docs/82379/2116766?lang=zh （查询推理用量，`GetInferenceUsage`），仅取**套餐额度**数据 |
| D2 | UI 形式 | **不自动刷新、不用状态栏**。`/show-usage` 开关命令：执行显示边栏（widget），再执行隐藏。打开时查询一次（带缓存） |
| D3 | 配置位置 | **插件目录下 `config/` 文件夹**，JSON 按平台建：先只有 `config/volcengine.json`，后续每供应商一个文件 |
| D4 | 数据范围 | 只要**套餐额度**（窗口用量 + 重置时间），不做推理用量明细 |

## 3. 总体架构

```
┌─────────────────────────────────────────────┐
│  pi 集成层（src/index.ts）                    │
│  - /show-usage 开关命令 → 边栏 widget 显隐     │
│  - query_usage 工具（供 LLM 查询，次要能力）   │
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

- **`GetInferenceUsage`（查询推理用量）** — 唯一依据文档：
  https://docs.volcengine.com/docs/82379/2116766?lang=zh
- 网关：`https://open.volcengineapi.com`
- Service：`ark`，Version：`2024-01-01`，Region：`cn-beijing`
- 请求方式：火山引擎 OpenAPI 通用规范（V4 签名，HMAC-SHA256）
- ⚠️ 具体请求参数与响应字段开发时**以该文档正文为准**，不臆造字段

### 4.2 凭证

- 需要**火山引擎 AccessKey（AK/SK）**，控制台 https://console.volcengine.com/iam/keymanage 创建
- 子账户需具备 `AccessKeySelfManageAccess` 和 `ArkReadOnlyAccess` 权限
- 不使用方舟 API Key（那是推理鉴权用的，管控面 OpenAPI 走 AK/SK）

### 4.3 查询逻辑

1. 调用 `GetInferenceUsage` 获取套餐额度数据（5h / 周 / 月窗口用量、剩余次数、重置时间）
2. 归一化为 `UsageSnapshot` 返回
3. 不做推理用量明细统计（决策 D4）

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

### 5.2 交互设计（决策 D2）

| 能力 | 名称 | 说明 |
|------|------|------|
| 命令（核心） | `/show-usage` | **开关**：无 widget 时 → 查询一次并在边栏显示；已有 widget → 移除隐藏。不自动轮询 |
| 工具（次要） | `query_usage` | 供 LLM 调用，参数：`account?`（账号名，缺省查全部），返回文本快照 |

边栏 widget 内容（示例）：

```
📊 火山Coding (coding)
  5h窗口  ▓▓▓▓░░░░░░ 320/1200  4h12m后重置
  本周    ▓▓░░░░░░░░ 2100/9000
  本月    ▓░░░░░░░░░ 5300/18000
```

- 查询中显示"查询中…"，失败显示错误原因与重试提示（可再次 `/show-usage` 重查）
- 缓存 5 分钟内重复打开不打 API

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
      "accessKeyId": "AK",
      "secretAccessKey": "SK"
    },
    {
      "label": "火山Agent",
      "planType": "agent",
      "accessKeyId": "AK",
      "secretAccessKey": "SK"
    }
  ],
  "cacheTtlSeconds": 300
}
```

- 仓库提供 `config/volcengine.example.json` 模板，真实配置文件加入 `.gitignore`
- `secretAccessKey` 支持环境变量占位写法（如 `"$VOLC_SECRET_KEY"`），避免明文落盘
- 后续新增供应商 = `config/<平台>.json` + 对应 provider 实现

### 5.4 缓存与错误处理

- 查询结果缓存（默认 5 分钟，`cacheTtlSeconds` 可调）
- 单账号查询失败不影响其他账号；错误信息带原因（签名失败/权限不足/网络超时）
- 所有请求支持 `AbortSignal`，随 pi 会话取消

## 6. 目录结构

```
pi-volcengine-usage/
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
| M1 | `feat/ark-provider` | 火山方舟 provider：V4 签名 + `GetInferenceUsage` 查询 + 归一化，CLI 脚本可独立跑通 |
| M2 | `feat/show-usage` | pi 扩展入口：`/show-usage` 开关命令 + 边栏 widget + `query_usage` 工具 |
| M3 | 按需 | 后续供应商接入（暂不做） |

## 8. 变更记录

- v2（2026-02）：按用户确认修订——接口以官方文档 2116766 为准且只取套餐额度；UI 改为 `/show-usage` 开关 + 边栏 widget（不轮询、不用状态栏）；配置移至插件目录 `config/` 按平台建 JSON。
- v1（2026-02）：初版设计（含 GetUsageDetails、状态栏、~/.pi 配置等，已被 v2 取代）。
