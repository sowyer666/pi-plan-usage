/**
 * 火山方舟（volcengine-ark）供应商实现
 *
 * planType 分发：
 * - coding → GetCodingPlanUsage（响应：Result.QuotaUsage[]，含 Label/Level + Percent + UpdateTimestamp）
 * - agent  → GetAFPUsage（响应：Result，窗口 used/total 为数字，重置时间为时间戳）
 *
 * 响应字段解析做防御性兼容（大小写变体、秒/毫秒时间戳），
 * 原始响应保留在 snapshot.raw 便于排查。
 */

import {
  classifyWindow,
  registerProvider,
  type Credential,
  type ProviderAccountConfig,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow,
} from "../types.ts";
import { callArkOpenAPI } from "./api.ts";
import { formatWidgetLines } from "../../format.ts";

/** 从对象中按候选 key 依次取第一个非空值 */
function pick(o: unknown, ...keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** 时间值 → ISO8601；兼容秒/毫秒时间戳与 RFC3339 字符串 */
function toISO(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v; // 秒 → 毫秒
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/** 从 API 响应中提取业务结果对象 */
function extractResult(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const result = (pick(d, "Result", "result") ?? d) as Record<string, unknown>;
  return result && typeof result === "object" ? result : {};
}

/** 提取窗口列表：兼容 QuotaUsage / Periods 等命名，兼容直接给数组 */
function extractWindowList(result: Record<string, unknown>): unknown[] {
  if (Array.isArray(result)) return result;
  const list = pick(result, "QuotaUsage", "Periods", "periods", "QuotaUsages");
  return Array.isArray(list) ? list : [];
}

function normalizeWindows(result: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const item of extractWindowList(result)) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const label = String(pick(p, "Label", "label", "Level", "level", "Window", "Type") ?? "unknown");
    windows.push({
      kind: classifyWindow(label),
      label,
      used: pick(p, "Used", "used", "RequestUsed") as number | undefined,
      total: pick(p, "Total", "total", "Limit", "Quota") as number | undefined,
      percent: pick(p, "Percent", "percent", "UsagePercent") as number | undefined,
      resetAt: toISO(
        pick(p, "ResetAt", "reset_at", "ResetTime", "ResetTimestamp", "NextResetTime", "ExpireTime"),
      ),
    });
  }
  return windows;
}

export const volcengineArkProvider: UsageProvider = {
  id: "volcengine-ark",
  displayName: "火山方舟",

  parseCredential(config: ProviderAccountConfig): Credential {
    const planType = String(config.planType ?? "coding").toLowerCase();
    if (planType !== "coding" && planType !== "agent") {
      throw new Error(`planType 必须为 coding 或 agent，当前: ${config.planType}`);
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error(`账号[${config.label ?? planType}] 缺少 accessKeyId / secretAccessKey`);
    }
    return {
      accountLabel: config.label ?? (planType === "agent" ? "火山Agent" : "火山Coding"),
      planType,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  },

  async queryUsage(cred: Credential, signal?: AbortSignal): Promise<UsageSnapshot> {
    const action = cred.planType === "agent" ? "GetAFPUsage" : "GetCodingPlanUsage";
    const data = await callArkOpenAPI(cred, action, signal);

    const result = extractResult(data);
    const windows = normalizeWindows(result);
    const tier = pick(result, "Tier", "tier", "PlanTier", "Edition");

    return {
      providerId: volcengineArkProvider.id,
      accountLabel: cred.accountLabel,
      planType: cred.planType,
      tier: tier !== undefined ? String(tier) : undefined,
      subscribed: windows.length > 0,
      windows,
      fetchedAt: new Date().toISOString(),
      raw: data,
    };
  },

  formatWidget(snapshot: UsageSnapshot): string[] {
    return formatWidgetLines(snapshot);
  },
};

registerProvider(volcengineArkProvider);
