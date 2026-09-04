/**
 * 供应商抽象层：通用类型 + 注册表
 *
 * 新增供应商 = 实现一个 UsageProvider 并调用 registerProvider()，
 * pi 集成层代码零改动。
 */

/** 额度窗口种类 */
export type WindowKind = "rolling5h" | "weekly" | "monthly" | "other";

/** 单个额度窗口（5小时 / 周 / 月等） */
export interface UsageWindow {
  kind: WindowKind;
  /** 原始窗口标签，如 "5h" / "session" / "weekly" / "monthly" */
  label: string;
  used?: number;
  total?: number;
  /** 已用百分比 0-100（部分供应商只给百分比不给 used/total） */
  percent?: number;
  /** 重置时间（ISO8601） */
  resetAt?: string;
}

/** 通用用量快照：所有供应商查询结果都归一化为此结构 */
export interface UsageSnapshot {
  providerId: string;
  accountLabel: string;
  planType: string;
  /** 套餐档位，如 "lite" / "pro" / "medium"，供应商可能不提供 */
  tier?: string;
  /** 是否有有效订阅/用量数据 */
  subscribed: boolean;
  windows: UsageWindow[];
  /** 查询时间（ISO8601） */
  fetchedAt: string;
  /** 保留原始响应，便于排查字段问题 */
  raw?: unknown;
}

/** 解析后的凭证 */
export interface Credential {
  accountLabel: string;
  planType: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** 配置文件中单账号的原始配置 */
export interface ProviderAccountConfig {
  label?: string;
  planType: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** 供应商接口 */
export interface UsageProvider {
  id: string;
  displayName: string;
  /** 校验并解析该供应商的凭证配置 */
  parseCredential(config: ProviderAccountConfig): Credential;
  /** 查询用量（快照） */
  queryUsage(cred: Credential, signal?: AbortSignal): Promise<UsageSnapshot>;
  /** 边栏多行展示 */
  formatWidget(snapshot: UsageSnapshot): string[];
}

/** 供应商注册表：id → 实例 */
export const registry = new Map<string, UsageProvider>();

export function registerProvider(p: UsageProvider): void {
  registry.set(p.id, p);
}

/** 按窗口标签归类窗口种类 */
export function classifyWindow(label: string): WindowKind {
  const l = label.toLowerCase();
  if (l.includes("5h") || l.includes("session")) return "rolling5h";
  if (l.includes("week")) return "weekly";
  if (l.includes("month")) return "monthly";
  return "other";
}
