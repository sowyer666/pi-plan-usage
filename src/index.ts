/**
 * pi-plan-usage — 在 pi 状态栏显示各 AI 供应商订阅套餐用量。
 *
 * 命令：
 *   /show-usage [provider] [plan] [on|off]   切换/设置状态栏用量显示
 *   /show-usage all | off | status           全部显示 / 全部隐藏 / 查看状态
 *   无参：帮助 + 当前显隐状态
 *
 * provider 短名 = config/<短名>.json 的文件名（如 ark → config/ark.json）。
 * plan 由各供应商定义（方舟：coding / agent）。
 * 状态栏中已开启的套餐每 refreshIntervalSeconds（默认 120s）自动刷新。
 *
 * 实现要点：
 * - 用 provider 抽象（providers/types.ts），新增供应商 = 一个实现 + 一个配置文件。
 * - 参数补全走 pi 原生 getArgumentCompletions，候选 value 携带完整参数路径
 *   （"ark coding on"），因为 pi 应用补全时替换整个参数区——完整路径保证不丢已输参数。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadAllConfigs, type ProviderFileConfig } from "./config.ts";
import { TTLCache } from "./cache.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatCompactLine, formatSnapshotText } from "./format.ts";
import { showUsageMenu } from "./menu.ts";
// import 即触发注册
import "./providers/volcengine-ark/index.ts";

const STATUS_KEY = "volcengine-usage";
const DEFAULT_REFRESH_MS = 120_000;
const ERROR_CACHE_MS = 30_000;

/** 一个可显示的目标（供应商 + 套餐） */
interface UsageTarget {
  providerId: string;
  shortName: string;
  planType: string;
  cacheTtlSeconds: number;
}

// ---------- 纯函数 ----------

/** k/M 紧凑数字（与 pi 默认 footer 一致） */
function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** 套餐标签：首字母大写取前 2 位（coding→C, agent→A, pro→P） */
function planTag(planType: string): string {
  return planType.slice(0, 2).toUpperCase();
}

// ---------- 供应商/配置查询（依赖 registry 与 config/ 目录） ----------

/** 短名（或完整 id）→ 完整 provider id */
function providerIdFor(shortName: string): string {
  for (const [id, p] of registry) {
    if (p.shortName === shortName || id === shortName || id.endsWith(`-${shortName}`)) return id;
  }
  return shortName;
}

/** 命令 token → 配置文件（匹配短名或完整 id），无匹配返回 undefined */
function resolveProviderFile(token: string): ProviderFileConfig | undefined {
  const t = token.toLowerCase();
  return loadAllConfigs().providers.find((p) => {
    const id = providerIdFor(p.shortName);
    return p.shortName === t || id === t || id.endsWith(`-${t}`);
  });
}

/** 指定 provider + plan 的作用目标；都缺省 = 全部 */
function resolveTargets(providerToken?: string, planToken?: string): UsageTarget[] {
  const files = providerToken ? [resolveProviderFile(providerToken)] : loadAllConfigs().providers;
  const targets: UsageTarget[] = [];
  for (const file of files) {
    if (!file) continue;
    for (const acc of file.accounts) {
      const planType = String(acc.planType).toLowerCase();
      if (planToken && planType !== planToken.toLowerCase()) continue;
      targets.push({
        providerId: providerIdFor(file.shortName),
        shortName: file.shortName,
        planType,
        cacheTtlSeconds: file.cacheTtlSeconds,
      });
    }
  }
  return targets;
}

// ---------- 扩展主体 ----------

export default function (pi: ExtensionAPI) {
  /** 显隐状态：key = `${providerId}:${planType}` */
  const enabled = new Map<string, boolean>();
  const cache = new TTLCache<UsageSnapshot | Error>();
  /** 状态栏右侧文本（空 = 不显示） */
  let usageRightText = "";
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  /** 是否已有开启的套餐 */
  function anyEnabled(): boolean {
    for (const on of enabled.values()) if (on) return true;
    return false;
  }

  /** 查询一个目标（force = 绕过缓存），异常以 Error 返回而非抛出 */
  async function queryTarget(target: UsageTarget, force = false): Promise<UsageSnapshot | Error> {
    const provider = registry.get(target.providerId);
    if (!provider) return new Error(`provider ${target.providerId} not registered`);

    const file = loadAllConfigs().providers.find((p) => p.shortName === target.shortName);
    const acc = file?.accounts.find(
      (a) => String(a.planType).toLowerCase() === target.planType,
    );
    if (!acc) return new Error(`no ${target.planType} account for ${target.shortName}`);

    const key = `${target.providerId}:${target.planType}`;
    let cached = force ? undefined : cache.get(key);
    if (!cached) {
      try {
        cached = await provider.queryUsage(provider.parseCredential(acc));
        cache.set(key, cached, target.cacheTtlSeconds * 1000);
      } catch (e) {
        cached = e instanceof Error ? e : new Error(String(e));
        cache.set(key, cached, ERROR_CACHE_MS); // 错误短缓存，避免高频重试
      }
    }
    return cached;
  }

  /** 按显隐状态重新生成状态栏文本；多供应商时段落带短名前缀 */
  async function refreshUsageText(force = false): Promise<void> {
    const byProvider = new Map<string, UsageTarget[]>();
    for (const [key, on] of enabled) {
      if (!on) continue;
      const [providerId, planType] = key.split(":");
      const provider = registry.get(providerId);
      const shortName = provider?.shortName ?? providerId;
      const file = loadAllConfigs().providers.find((p) => p.shortName === shortName);
      const target: UsageTarget = {
        providerId,
        shortName,
        planType,
        cacheTtlSeconds: file?.cacheTtlSeconds ?? 300,
      };
      (byProvider.get(shortName) ?? byProvider.set(shortName, []).get(shortName)!).push(target);
    }

    const segments: string[] = [];
    for (const [shortName, targets] of byProvider) {
      const prefix = byProvider.size > 1 ? `${shortName} ` : "";
      const parts: string[] = [];
      for (const t of targets) {
        const snap = await queryTarget(t, force);
        parts.push(
          snap instanceof Error
            ? `${planTag(t.planType)}:query failed`
            : `${planTag(t.planType)}:${formatCompactLine(snap)}`,
        );
      }
      segments.push(prefix + parts.join(" "));
    }
    usageRightText = segments.join(" | ");
  }

  // ---------- 命令 ----------

  /** 执行一条指令（与命令行参数同构）：解析后切换显隐并刷新状态栏 */
  async function executeShowUsage(args: string, ctx: any): Promise<void> {
    const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);

    if (tokens[0] === "status") {
      const lines = loadAllConfigs()
        .providers.map((f) => {
          const plans = f.accounts
            .map((a) => String(a.planType).toLowerCase())
            .map((p) => `${p}:${enabled.get(`${providerIdFor(f.shortName)}:${p}`) ? "on" : "off"}`);
          return `${f.shortName} ${plans.join(" ")}`;
        })
        .join(" | ");
      ctx.ui.notify(lines || "No provider config", "info");
      return;
    }
    if (tokens[0] === "off") {
      for (const key of [...enabled.keys()]) enabled.set(key, false);
      usageRightText = "";
      ctx.ui.notify("Usage display turned off", "info");
      return;
    }

    // 解析 [provider] [plan] [on|off|toggle]；多余参数或未知 provider 时报错提示
    let providerToken: string | undefined;
    let planToken: string | undefined;
    let action: "toggle" | "on" | "off" = "toggle";
    for (const t of tokens) {
      if (t === "on" || t === "off" || t === "toggle") {
        action = t;
      } else if (!providerToken) {
        providerToken = t;
      } else if (!planToken) {
        planToken = t;
      } else {
        ctx.ui.notify("Usage: /show-usage [provider] [plan] [on|off] | all | off | status", "warning");
        return;
      }
    }
    if (providerToken === "all") {
      providerToken = undefined;
      action = "on";
    }
    if (providerToken && !resolveProviderFile(providerToken)) {
      const names = loadAllConfigs()
        .providers.map((p) => p.shortName)
        .join(", ");
      ctx.ui.notify(`Unknown provider "${providerToken}". Available: ${names}`, "warning");
      return;
    }

    const targets = resolveTargets(providerToken, planToken);
    if (targets.length === 0) {
      ctx.ui.notify(
        `No match${providerToken ? ` for "${providerToken}"` : ""}${planToken ? ` plan "${planToken}"` : ""}`,
        "warning",
      );
      return;
    }

    // toggle：范围内任一开启则全关，否则全开；显式 on/off 按字面
    const next =
      action === "toggle"
        ? !targets.some((t) => enabled.get(`${t.providerId}:${t.planType}`))
        : action === "on";
    for (const t of targets) {
      const key = `${t.providerId}:${t.planType}`;
      if (!next) cache.delete(key); // 关闭清缓存，再开即强制刷新
      enabled.set(key, next);
    }

    try {
      await refreshUsageText(true);
      ctx.ui.notify(
        anyEnabled()
          ? `Showing: ${[...enabled.entries()].filter(([, v]) => v).map(([k]) => k.split(":")[1]).join(", ")}`
          : "Usage display turned off",
        "info",
      );
    } catch (e) {
      ctx.ui.notify(`Query failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  pi.registerCommand("show-usage", {
    description: "Show plan usage in status bar (no args opens interactive picker)",
    handler: async (args, ctx) => {
      const direct = (args ?? "").trim();
      // 无参数 → 打开交互式菜单，由菜单返回指令再执行
      if (!direct) {
        const providers = loadAllConfigs().providers;
        const menuArg = await showUsageMenu(ctx, providers, (shortName, plan) =>
          enabled.get(`${providerIdFor(shortName)}:${plan}`) === true,
        );
        if (!menuArg) return; // 用户取消
        await executeShowUsage(menuArg, ctx);
        return;
      }
      // 带完整参数 → 直接执行（脚本/LLM 调用）
      await executeShowUsage(direct, ctx);
    },
  });

  // ---------- 状态栏（自定义 footer，复刻 pi 默认布局，用量右对齐） ----------

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // 自动刷新定时器（取各供应商 refreshIntervalSeconds 最小值）；后台静默失败
    if (!refreshTimer) {
      let intervalMs = DEFAULT_REFRESH_MS;
      try {
        intervalMs = loadAllConfigs().refreshIntervalSeconds * 1000;
      } catch {
        // 配置不可用时用默认值
      }
      refreshTimer = setInterval(async () => {
        if (anyEnabled()) {
          await refreshUsageText(true).catch(() => {});
          // 空 notify 仅用于触发 TUI 重绘（自定义 footer 不会自动重绘）
          ctx.ui.notify("", "info");
        }
      }, intervalMs);
      refreshTimer.unref?.();
    }

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        // 第 1 行：pwd + git 分支 + 会话名
        let pwd = ctx.cwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
        const branch = footerData.getGitBranch();
        if (branch) pwd += ` (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd += ` • ${sessionName}`;
        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

        // 第 2 行：左 token 统计，右模型名（与默认 footer 一致）
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
        const pct = contextUsage?.percent;
        const ctxStr =
          pct != null ? `${pct.toFixed(1)}%/${formatTokens(ctxWindow)}` : `?/${formatTokens(ctxWindow)}`;
        statsParts.push(pct != null && pct > 90 ? theme.fg("error", ctxStr) : pct != null && pct > 70 ? theme.fg("warning", ctxStr) : ctxStr);

        const statsLeft = statsParts.join(" ");
        const model = ctx.model?.id ?? "no-model";
        const modelSide = ctx.model?.reasoning
          ? ctx.thinkingLevel === "off"
            ? `${model} • thinking off`
            : `${model} • ${ctx.thinkingLevel}`
          : model;
        const statsLine =
          visibleWidth(statsLeft) + 2 + visibleWidth(modelSide) <= width
            ? theme.fg("dim", statsLeft) +
              theme.fg("dim", " ".repeat(width - visibleWidth(statsLeft) - visibleWidth(modelSide)) + modelSide)
            : theme.fg("dim", truncateToWidth(statsLeft, width, "..."));

        // 第 3 行：左 = 其他扩展状态，右 = 用量（右对齐）
        const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
          .filter(([k]) => k !== STATUS_KEY)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
          .filter(Boolean)
          .join(" ");
        const right = usageRightText;
        let statusLine: string;
        if (right) {
          const leftW = visibleWidth(otherStatuses);
          const rightW = visibleWidth(right);
          if (leftW + 2 + rightW <= width) {
            statusLine =
              (otherStatuses ? theme.fg("dim", otherStatuses) : "") +
              " ".repeat(width - leftW - rightW) +
              theme.fg("dim", right);
          } else {
            const leftTrunc = otherStatuses
              ? truncateToWidth(otherStatuses, Math.max(0, width - rightW - 2), "...")
              : "";
            statusLine =
              (leftTrunc ? theme.fg("dim", leftTrunc) : "") +
              " ".repeat(Math.max(1, width - visibleWidth(leftTrunc) - rightW)) +
              theme.fg("dim", right);
          }
        } else {
          statusLine = otherStatuses
            ? theme.fg("dim", truncateToWidth(otherStatuses, width, theme.fg("dim", "...")))
            : "";
        }

        const lines = [pwdLine, statsLine];
        if (statusLine) lines.push(statusLine);
        return lines;
      },
    }));
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  });

  // ---------- 工具（供 LLM 调用） ----------

  pi.registerTool({
    name: "query_usage",
    label: "Query plan usage",
    description:
      "Query AI plan quota usage (5h/day/week/month windows, used quota, reset time). " +
      'provider is optional (e.g. "ark"), account label filter is optional, defaults to all.',
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Provider short name (e.g. ark)" })),
      account: Type.Optional(Type.String({ description: "Filter by account label (substring match)" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const config = loadAllConfigs();
        const provider = params?.provider?.toLowerCase();
        const files = provider
          ? config.providers.filter((p) => p.shortName === provider)
          : config.providers;
        if (files.length === 0) {
          return {
            content: [{ type: "text", text: `No matching provider: ${provider}` }],
            details: {},
          };
        }

        const parts: string[] = [];
        await Promise.allSettled(
          files.flatMap((file) => {
            const providerId = providerIdFor(file.shortName);
            const providerImpl = registry.get(providerId);
            const filter = params?.account;
            return file.accounts
              .filter((a) => !filter || (a.label ?? "").includes(filter))
              .map(async (acc) => {
                if (!providerImpl) {
                  parts.push(`❌ Account[${acc.label ?? acc.planType}]: provider ${providerId} not registered`);
                  return;
                }
                const cred = providerImpl.parseCredential(acc);
                const key = `${providerId}:${cred.accountLabel}`;
                let cached = cache.get(key);
                if (!cached) {
                  try {
                    cached = await providerImpl.queryUsage(cred);
                    cache.set(key, cached, file.cacheTtlSeconds * 1000);
                  } catch (e) {
                    cached = e instanceof Error ? e : new Error(String(e));
                    cache.set(key, cached, ERROR_CACHE_MS);
                  }
                }
                parts.push(
                  cached instanceof Error ? `❌ ${cred.accountLabel}: ${cached.message}` : formatSnapshotText(cached),
                );
                parts.push("");
              });
          }),
        );
        return { content: [{ type: "text", text: parts.join("\n").trimEnd() }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Query failed: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
