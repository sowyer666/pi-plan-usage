/**
 * pi-volcengine-usage — pi 扩展入口
 *
 * - /show-usage [coding|agent|all]：分别开关 Coding Plan / Agent Plan 在底部状态栏的显示。
 *   通过 setFooter 自定义 footer：复刻默认信息（pwd / token 统计 / 模型名 / 其他扩展状态），
 *   用量文本整体**右对齐**在扩展状态行右侧。
 *   关闭 = 清缓存，再开 = 强制刷新；不自动轮询（设计决策 D2）。
 * - query_usage 工具：供 LLM 查询用量，返回文本快照
 * - 结果缓存（默认 5 分钟）避免重复打 API
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadConfig } from "./config.ts";
import { TTLCache } from "./cache.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatCompactLine, formatSnapshotText } from "./format.ts";
// 火山方舟 provider（import 触发注册）
import "./providers/volcengine-ark/index.ts";

const STATUS_KEY = "volcengine-usage";
type PlanType = "coding" | "agent";

/** k/M 紧凑数字（与 pi 默认 footer 一致） */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export default function (pi: ExtensionAPI) {
  // 各 plan 在状态栏的开关状态（会话内有效）
  const enabled: Record<PlanType, boolean> = { coding: false, agent: false };
  // 缓存放在闭包里，随扩展实例生命周期存在
  let cache = new TTLCache<UsageSnapshot | Error>();
  // 当前用量右对齐文本（空 = 不显示）
  let usageRightText = "";
  // 状态栏自动刷新定时器（session_start 启动，session_shutdown 清理）
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  /** 查询指定 planType 的账号（取配置中第一个匹配项）；force = 绕过缓存强制查询 */
  async function queryPlan(planType: PlanType, force = false): Promise<UsageSnapshot | Error> {
    const config = loadConfig();
    const ttlMs = config.cacheTtlSeconds * 1000;
    const acc = config.accounts.find((a) => String(a.planType).toLowerCase() === planType);
    if (!acc) return new Error(`配置中没有 ${planType} 账号`);

    const provider = registry.get("volcengine-ark");
    if (!provider) return new Error("供应商 volcengine-ark 未注册");

    const cred = provider.parseCredential(acc);
    const key = `${provider.id}:${planType}`;
    let cached = force ? undefined : cache.get(key);
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

  /** 按当前开关状态更新用量右对齐文本 */
  async function refreshUsageText(force = false): Promise<void> {
    const parts: string[] = [];
    for (const plan of ["coding", "agent"] as PlanType[]) {
      if (!enabled[plan]) continue;
      const snap = await queryPlan(plan, force);
      const tag = plan === "coding" ? "C" : "A";
      parts.push(snap instanceof Error ? `${tag}:查询失败` : `${tag}:${formatCompactLine(snap)}`);
    }
    usageRightText = parts.join(" | ");
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

      try {
        await refreshUsageText();
        ctx.ui.notify(
          enabled.coding || enabled.agent
            ? `用量显示: ${[enabled.coding ? "coding" : null, enabled.agent ? "agent" : null].filter(Boolean).join(" + ")}`
            : "用量显示已全部关闭",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`查询失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // 自定义 footer：复刻默认 3 行 + 用量文本右对齐在扩展状态行。
  // 注意：这里只注册一次命令；footer 在 session_start 时重设（session 替换后旧 footer 会被清理）。
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // 状态栏自动刷新定时器（默认 2 分钟；后台静默失败，不打断 UI）
    if (!refreshTimer) {
      let intervalMs = 120_000;
      try {
        intervalMs = loadConfig().refreshIntervalSeconds * 1000;
      } catch {
        // 配置不可用时用默认值
      }
      refreshTimer = setInterval(() => {
        if (enabled.coding || enabled.agent) {
          refreshUsageText(true).catch(() => {});
        }
      }, intervalMs);
      refreshTimer.unref?.(); // 不阻止 pi 退出
    }

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        // ---- 行1：pwd + git 分支 + 会话名 ----
        let pwd = ctx.cwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
        const branch = footerData.getGitBranch();
        if (branch) pwd += ` (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd += ` • ${sessionName}`;
        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

        // ---- 行2：左 token 统计 + 右模型名（复刻默认逻辑）----
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
        let latestCacheHitRate: number | undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
          const u = entry.type === "message" ? (entry.message as any)?.usage : (entry as any)?.usage;
          if (!u) continue;
          input += u.input ?? 0;
          output += u.output ?? 0;
          cacheRead += u.cacheRead ?? 0;
          cacheWrite += u.cacheWrite ?? 0;
          cost += u.cost?.total ?? 0;
          if (entry.type === "message" && (entry.message as any)?.role === "assistant") {
            const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
            latestCacheHitRate = promptTokens > 0 ? ((u.cacheRead ?? 0) / promptTokens) * 100 : undefined;
          }
        }

        const statsParts: string[] = [];
        if (input) statsParts.push(`↑${formatTokens(input)}`);
        if (output) statsParts.push(`↓${formatTokens(output)}`);
        if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
        if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
        if (cacheRead + cacheWrite > 0 && latestCacheHitRate !== undefined) {
          statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
        }
        if (cost) statsParts.push(`$${cost.toFixed(3)}`);

        const contextUsage = ctx.getContextUsage();
        const ctxWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        if (contextUsage?.percent != null) {
          const pct = contextUsage.percent;
          const display = `${pct.toFixed(1)}%/${formatTokens(ctxWindow)}`;
          statsParts.push(pct > 90 ? theme.fg("error", display) : pct > 70 ? theme.fg("warning", display) : display);
        } else {
          statsParts.push(`?/${formatTokens(ctxWindow)}`);
        }

        let statsLeft = statsParts.join(" ");
        const modelName = ctx.model?.id ?? "no-model";
        let rightSide = ctx.model?.reasoning
          ? ctx.thinkingLevel === "off"
            ? `${modelName} • thinking off`
            : `${modelName} • ${ctx.thinkingLevel}`
          : modelName;

        let statsLine: string;
        if (visibleWidth(statsLeft) + 2 + visibleWidth(rightSide) <= width) {
          const padding = " ".repeat(width - visibleWidth(statsLeft) - visibleWidth(rightSide));
          statsLine = theme.fg("dim", statsLeft) + theme.fg("dim", padding + rightSide);
        } else {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLine = theme.fg("dim", statsLeft);
        }

        // ---- 行3：左 = 其他扩展状态，右 = 用量（右对齐）----
        const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
          .filter(([k]) => k !== STATUS_KEY)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
          .filter(Boolean)
          .join(" ");
        const right = usageRightText ? theme.fg("dim", usageRightText) : "";

        let statusLine: string;
        if (right) {
          const leftW = visibleWidth(otherStatuses);
          const rightW = visibleWidth(usageRightText);
          if (leftW + 2 + rightW <= width) {
            statusLine =
              (otherStatuses ? theme.fg("dim", otherStatuses) : "") +
              " ".repeat(width - leftW - rightW) +
              right;
          } else {
            // 太窄：优先保用量，左侧截断
            const availLeft = Math.max(0, width - rightW - 2);
            const leftTrunc = otherStatuses ? truncateToWidth(otherStatuses, availLeft, "...") : "";
            statusLine =
              (leftTrunc ? theme.fg("dim", leftTrunc) : "") +
              " ".repeat(Math.max(1, width - visibleWidth(leftTrunc) - rightW)) +
              right;
          }
        } else if (otherStatuses) {
          statusLine = theme.fg("dim", truncateToWidth(otherStatuses, width, theme.fg("dim", "...")));
        } else {
          statusLine = "";
        }

        const lines = [pwdLine, statsLine];
        if (statusLine) lines.push(statusLine);
        return lines;
      },
    }));
  });

  // 会话结束/替换时清理定时器
  pi.on("session_shutdown", () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  });

  pi.registerTool({
    name: "query_usage",
    label: "查询套餐用量",
    description:
      "查询火山引擎 Coding Plan / Agent Plan 套餐用量（5小时窗口/日/周/月额度、已用、重置时间）。" +
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
