/**
 * pi-volcengine-usage — pi 扩展入口
 *
 * - /show-usage [coding|agent|all]：分别开关 Coding Plan / Agent Plan 在**底部状态栏**的显示
 *   （ctx.ui.setStatus，单行紧凑格式）。关闭 = 隐藏并清缓存，再开 = 强制刷新。
 *   不自动轮询（设计决策 D2）。
 * - query_usage 工具：供 LLM 查询用量，返回文本快照
 * - 结果缓存（默认 5 分钟）避免重复打 API
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig } from "./config.ts";
import { TTLCache } from "./cache.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatCompactLine, formatSnapshotText } from "./format.ts";
// 火山方舟 provider（import 触发注册）
import "./providers/volcengine-ark/index.ts";

const STATUS_KEY = "volcengine-usage";
type PlanType = "coding" | "agent";

export default function (pi: ExtensionAPI) {
  // 各 plan 在状态栏的开关状态（会话内有效）
  const enabled: Record<PlanType, boolean> = { coding: false, agent: false };
  // 缓存放在闭包里，随扩展实例生命周期存在
  let cache = new TTLCache<UsageSnapshot | Error>();

  /** 查询指定 planType 的账号（取配置中第一个匹配项），带缓存 */
  async function queryPlan(planType: PlanType): Promise<UsageSnapshot | Error> {
    const config = loadConfig();
    const ttlMs = config.cacheTtlSeconds * 1000;
    const acc = config.accounts.find((a) => String(a.planType).toLowerCase() === planType);
    if (!acc) return new Error(`配置中没有 ${planType} 账号`);

    const provider = registry.get("volcengine-ark");
    if (!provider) return new Error("供应商 volcengine-ark 未注册");

    const cred = provider.parseCredential(acc);
    const key = `${provider.id}:${planType}`;
    let cached = cache.get(key);
    if (!cached) {
      try {
        cached = await provider.queryUsage(cred);
        cache.set(key, cached, ttlMs);
      } catch (e) {
        cached = e instanceof Error ? e : new Error(String(e));
        cache.set(key, cached, 30_000); // 错误短缓存，避免高频重试
      }
    }
    return cached;
  }

  /** 按当前开关状态刷新状态栏文本 */
  async function refreshStatus(ctx: any): Promise<void> {
    const parts: string[] = [];
    for (const plan of ["coding", "agent"] as PlanType[]) {
      if (!enabled[plan]) continue;
      const snap = await queryPlan(plan);
      const tag = plan === "coding" ? "C" : "A";
      parts.push(snap instanceof Error ? `${tag}:查询失败` : `${tag}:${formatCompactLine(snap)}`);
    }
    ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" | ") : undefined);
  }

  pi.registerCommand("show-usage", {
    description: "开关状态栏用量显示：/show-usage [coding|agent|all]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (!arg || arg === "all") {
        const anyOn = enabled.coding || enabled.agent;
        enabled.coding = enabled.agent = !anyOn;
      } else if (arg === "coding" || arg === "c") {
        enabled.coding = !enabled.coding;
      } else if (arg === "agent" || arg === "a") {
        enabled.agent = !enabled.agent;
      } else {
        ctx.ui.notify("用法: /show-usage [coding|agent|all]", "info");
        return;
      }

      // 关闭 = 清该 plan 的缓存，下次打开强制刷新
      const off: PlanType[] = [];
      if (!enabled.coding) off.push("coding");
      if (!enabled.agent) off.push("agent");
      for (const plan of off) cache.delete(`volcengine-ark:${plan}`);

      if (!enabled.coding && !enabled.agent) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      await refreshStatus(ctx);
    },
  });

  pi.registerTool({
    name: "query_usage",
    label: "查询套餐用量",
    description:
      "查询火山引擎 Coding Plan / Agent Plan 套餐用量（5小时窗口/周/月额度、已用、重置时间）。" +
      "account 可选，为配置中的账号 label（如\"火山Coding\"），缺省查询全部账号。",
    parameters: Type.Object({
      account: Type.Optional(Type.String({ description: "账号 label 过滤（包含匹配）" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const config = loadConfig();
        const filter = params?.account;
        const accounts = filter
          ? config.accounts.filter((a) => (a.label ?? "").includes(filter))
          : config.accounts;
        if (accounts.length === 0) {
          return { content: [{ type: "text", text: `未找到匹配的账号: ${filter}` }], details: {} };
        }

        const parts: string[] = [];
        await Promise.allSettled(
          accounts.map(async (acc) => {
            const provider = registry.get("volcengine-ark");
            if (!provider) {
              parts.push(`❌ 账号[${acc.label ?? acc.planType}]: 供应商 volcengine-ark 未注册`);
              return;
            }
            const cred = provider.parseCredential(acc);
            const key = `${provider.id}:${cred.accountLabel}`;
            let cached = cache.get(key);
            if (!cached) {
              try {
                cached = await provider.queryUsage(cred);
                cache.set(key, cached, config.cacheTtlSeconds * 1000);
              } catch (e) {
                cached = e instanceof Error ? e : new Error(String(e));
                cache.set(key, cached, 30_000);
              }
            }
            parts.push(
              cached instanceof Error
                ? `❌ ${cred.accountLabel}: ${cached.message}`
                : formatSnapshotText(cached),
            );
            parts.push("");
          }),
        );
        return { content: [{ type: "text", text: parts.join("\n").trimEnd() }], details: {} };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `查询失败: ${e instanceof Error ? e.message : String(e)}` },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
