/**
 * pi-plan-usage — pi 扩展入口
 *
 * - /show-usage [provider] [plan] [on|off]：按供应商/套餐控制状态栏显示。
 *   provider 短名与配置文件名一致（ark → config/ark.json）。
 *   缺省 provider = 全部；缺省 plan = 该 provider 全部套餐；
 *   第三个参数显式 on/off，缺省为 toggle（范围内任一开启则全关，否则全开）。
 *   特殊字：all = 全部显示，off = 全部隐藏，status = 查看当前显隐状态。
 * - 状态栏（自定义 footer）每 refreshIntervalSeconds 自动刷新，仅刷新已开启的套餐。
 * - query_usage 工具：供 LLM 查询用量，返回文本快照。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadAllConfigs, type ProviderFileConfig } from "./config.ts";
import { TTLCache } from "./cache.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatCompactLine, formatSnapshotText } from "./format.ts";
// 火山方舟 provider（import 触发注册）
import "./providers/volcengine-ark/index.ts";

/** 一个可显示的"供应商+套餐"目标 */
interface UsageTarget {
  providerId: string;
  shortName: string;
  planType: string;
  cacheTtlSeconds: number;
}

const STATUS_KEY = "volcengine-usage";

/** k/M 紧凑数字（与 pi 默认 footer 一致） */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** 状态栏里套餐标签：planType 首字母大写（coding→C, agent→A, pro→P） */
function planTag(planType: string): string {
  return planType.charAt(0).toUpperCase() + planType.slice(1, 2);
}

export default function (pi: ExtensionAPI) {
  // 显隐状态：key = `${providerId}:${planType}`（会话内有效）
  const enabled = new Map<string, boolean>();
  // 缓存放在闭包里，随扩展实例生命周期存在
  let cache = new TTLCache<UsageSnapshot | Error>();
  // 当前用量右对齐文本（空 = 不显示）
  let usageRightText = "";
  // 状态栏自动刷新定时器（session_start 启动，session_shutdown 清理）
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  /** 全部配置的供应商文件 */
  function allProviderFiles(): ProviderFileConfig[] {
    return loadAllConfigs().providers;
  }

  /** 命令 token → provider 文件（匹配 shortName 或完整 id），不匹配返回 undefined */
  function resolveProviderFile(token: string): ProviderFileConfig | undefined {
    const t = token.toLowerCase();
    return allProviderFiles().find((p) => {
      const provider = registry.get(providerIdFor(p.shortName));
      return p.shortName === t || provider?.id === t || provider?.id.endsWith(`-${t}`);
    });
  }

  /** 短名 → 完整 provider id：registry 里 shortName 或 id 尾段匹配 */
  function providerIdFor(shortName: string): string {
    for (const [id, p] of registry) {
      if (p.shortName === shortName || id === shortName || id.endsWith(`-${shortName}`)) return id;
    }
    return shortName;
  }

  /** 计算命令作用的目标集合 */
  function resolveTargets(providerToken?: string, planToken?: string): UsageTarget[] {
    const files = providerToken ? [resolveProviderFile(providerToken)] : allProviderFiles();
    const targets: UsageTarget[] = [];
    for (const file of files) {
      if (!file) continue;
      const providerId = providerIdFor(file.shortName);
      for (const acc of file.accounts) {
        const planType = String(acc.planType).toLowerCase();
        if (planToken && planType !== planToken.toLowerCase()) continue;
        targets.push({
          providerId,
          shortName: file.shortName,
          planType,
          cacheTtlSeconds: file.cacheTtlSeconds,
        });
      }
    }
    return targets;
  }

  /** 查询指定 provider+plan；force = 绕过缓存强制查询 */
  async function queryTarget(
    target: UsageTarget,
    force = false,
  ): Promise<UsageSnapshot | Error> {
    const provider = registry.get(target.providerId);
    if (!provider) return new Error(`provider ${target.providerId} not registered`);

    const file = allProviderFiles().find((p) => p.shortName === target.shortName);
    const acc = file?.accounts.find((a) => String(a.planType).toLowerCase() === target.planType);
    if (!acc) return new Error(`no ${target.planType} account for ${target.shortName}`);

    const cred = provider.parseCredential(acc);
    const key = `${target.providerId}:${target.planType}`;
    let cached = force ? undefined : cache.get(key);
    if (!cached) {
      try {
        cached = await provider.queryUsage(cred);
        cache.set(key, cached, target.cacheTtlSeconds * 1000);
      } catch (e) {
        cached = e instanceof Error ? e : new Error(String(e));
        cache.set(key, cached, 30_000); // 错误短缓存，避免高频重试
      }
    }
    return cached;
  }

  /** 按当前显隐状态更新用量右对齐文本 */
  async function refreshUsageText(force = false): Promise<void> {
    // 按 provider 分组拼接：单 provider 段落间 " | "，段内各套餐 " "
    const byProvider = new Map<string, UsageTarget[]>();
    for (const [key, on] of enabled) {
      if (!on) continue;
      const [providerId, planType] = key.split(":");
      const provider = registry.get(providerId);
      const shortName = provider?.shortName ?? providerId;
      const file = allProviderFiles().find((p) => p.shortName === shortName);
      const target: UsageTarget = {
        providerId,
        shortName,
        planType,
        cacheTtlSeconds: file?.cacheTtlSeconds ?? 300,
      };
      const list = byProvider.get(shortName) ?? [];
      list.push(target);
      byProvider.set(shortName, list);
    }

    const segments: string[] = [];
    for (const [shortName, targets] of byProvider) {
      const parts: string[] = [];
      for (const t of targets) {
        const snap = await queryTarget(t, force);
        const tag = planTag(t.planType);
        parts.push(snap instanceof Error ? `${tag}:query failed` : `${tag}:${formatCompactLine(snap)}`);
      }
      // 多 provider 时段落前加短名，避免标签歧义
      segments.push((byProvider.size > 1 ? `${shortName} ` : "") + parts.join(" "));
    }
    usageRightText = segments.join(" | ");
  }

  /** 是否有任何套餐开启 */
  function anyEnabled(): boolean {
    for (const v of enabled.values()) if (v) return true;
    return false;
  }

  /** /show-usage 参数自动补全：按当前输入的第几个参数给出候选 */
  function argumentCompletions(argumentPrefix: string) {
    const typed = argumentPrefix.toLowerCase();
    const parts = typed.split(/\s+/).filter(Boolean);
    const completingNewToken = typed.endsWith(" ");
    // 正在输入中的 token（光标前的最后一段）；补全新 token 时空串
    const current = completingNewToken ? "" : (parts[parts.length - 1] ?? "");
    const argIndex = completingNewToken ? parts.length : parts.length - 1;

    const filter = (items: { value: string; description: string }[]) =>
      items.filter((i) => i.value.startsWith(current));

    // 第 1 个参数：特殊字 + 各 provider 短名
    if (argIndex === 0) {
      const items = [
        { value: "all", description: "Show all providers and plans" },
        { value: "off", description: "Hide everything" },
        { value: "status", description: "Show current on/off state" },
      ];
      for (const file of allProviderFiles()) {
        const plans = file.accounts.map((a) => String(a.planType).toLowerCase()).join("/");
        items.push({ value: file.shortName, description: `${providerIdFor(file.shortName)} (${plans})` });
      }
      return filter(items);
    }

    // 第 2 个参数：该 provider 的套餐列表 + on/off
    if (argIndex === 1) {
      const first = parts[0] ?? "";
      const file = resolveProviderFile(first);
      if (!file) return [{ value: "on", description: "Show" }, { value: "off", description: "Hide" }];
      const items = file.accounts.map((a) => ({
        value: String(a.planType).toLowerCase(),
        description: a.label ?? String(a.planType),
      }));
      items.push({ value: "on", description: "Show all plans of this provider" });
      items.push({ value: "off", description: "Hide all plans of this provider" });
      return filter(items);
    }

    // 第 3 个参数：显式 on / off
    return [
      { value: "on", description: "Show" },
      { value: "off", description: "Hide" },
    ];
  }

  pi.registerCommand("show-usage", {
    description: "Status bar plan usage: /show-usage [provider] [plan] [on|off] | all | off | status",
    getArgumentCompletions: (argumentPrefix) => argumentCompletions(argumentPrefix),
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

      // 特殊字
      if (tokens[0] === "status") {
        const lines: string[] = [];
        for (const file of allProviderFiles()) {
          const plans = file.accounts.map((a) => String(a.planType).toLowerCase());
          const states = plans.map((p) => `${p}:${enabled.get(`${providerIdFor(file.shortName)}:${p}`) ? "on" : "off"}`);
          lines.push(`${file.shortName} ${states.join(" ")}`);
        }
        ctx.ui.notify(lines.join(" | ") || "No provider config", "info");
        return;
      }
      if (tokens[0] === "off") {
        for (const key of [...enabled.keys()]) enabled.set(key, false);
        usageRightText = "";
        ctx.ui.notify("Usage display turned off", "info");
        return;
      }

      let providerToken: string | undefined;
      let planToken: string | undefined;
      let action: "toggle" | "on" | "off" = "toggle";

      for (const t of tokens) {
        if ((t === "on" || t === "off" || t === "toggle") && (providerToken || planToken)) {
          action = t as typeof action;
        } else if (!providerToken) {
          providerToken = t;
        } else if (!planToken) {
          planToken = t;
        } else {
          ctx.ui.notify("Usage: /show-usage [provider] [plan] [on|off] | all | off | status", "info");
          return;
        }
      }

      // 特殊：/show-usage all = 全部显示
      if (providerToken === "all") {
        providerToken = undefined;
        action = "on";
      }
      // 第一个 token 不是已知 provider 且第二个 token 也是普通词 → 可能用户直接写了 plan
      if (providerToken && !resolveProviderFile(providerToken)) {
        if (!planToken && allProviderFiles().some((f) => f.accounts.some((a) => String(a.planType).toLowerCase() === providerToken))) {
          // 如 "/show-usage coding"：把 token 当 plan，作用于全部 provider
          planToken = providerToken;
          providerToken = undefined;
        } else {
          const names = allProviderFiles().map((f) => f.shortName).join(", ");
          ctx.ui.notify(`Unknown provider "${providerToken}". Available: ${names}`, "error");
          return;
        }
      }

      const targets = resolveTargets(providerToken, planToken);
      if (targets.length === 0) {
        ctx.ui.notify(
          `No matching target${providerToken ? ` for ${providerToken}` : ""}${planToken ? ` plan ${planToken}` : ""}`,
          "error",
        );
        return;
      }

      // toggle 语义：范围内任一开启 → 全关；否则全开
      let next: boolean;
      if (action === "toggle") {
        next = !targets.some((t) => enabled.get(`${t.providerId}:${t.planType}`));
      } else {
        next = action === "on";
      }
      for (const t of targets) {
        const key = `${t.providerId}:${t.planType}`;
        if (!next) cache.delete(key); // 关闭 = 清缓存，再开强制刷新
        enabled.set(key, next);
      }

      try {
        await refreshUsageText(next); // 全开时强制刷新，关闭项走已有缓存也无妨
        ctx.ui.notify(
          anyEnabled()
            ? `Usage display: ${[...enabled.entries()].filter(([, v]) => v).map(([k]) => k.split(":")[1]).join(", ")}`
            : "Usage display turned off",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`Query failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // 自定义 footer：复刻默认 3 行 + 用量文本右对齐在扩展状态行。
  // 注意：这里只注册一次命令；footer 在 session_start 时重设（session 替换后旧 footer 会被清理）。
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // 状态栏自动刷新定时器（取各供应商 refreshIntervalSeconds 最小值；后台静默失败）
    if (!refreshTimer) {
      let intervalMs = 120_000;
      try {
        intervalMs = loadAllConfigs().refreshIntervalSeconds * 1000;
      } catch {
        // 配置不可用时用默认值
      }
      refreshTimer = setInterval(async () => {
        if (anyEnabled()) {
          await refreshUsageText(true).catch(() => {});
          ctx.ui.notify("", "info"); // 空通知仅用于触发 TUI 重绘，让状态栏拿到新数据
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
        const rightSide = ctx.model?.reasoning
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
    label: "Query plan usage",
    description:
      "Query AI plan quota usage (5h/day/week/month windows, used quota, reset time). " +
      "provider is optional (e.g. \"ark\"), account label filter is optional, defaults to all.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Provider short name (e.g. ark)" })),
      account: Type.Optional(Type.String({ description: "Filter by account label (substring match)" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const config = loadAllConfigs();
        const filter = params?.account;
        const files = params?.provider
          ? config.providers.filter((p) => p.shortName === params.provider!.toLowerCase())
          : config.providers;
        if (files.length === 0) {
          return { content: [{ type: "text", text: `No matching provider: ${params?.provider}` }], details: {} };
        }

        const parts: string[] = [];
        await Promise.allSettled(
          files.flatMap((file) => {
            const providerId = providerIdFor(file.shortName);
            const provider = registry.get(providerId);
            return file.accounts
              .filter((a) => !filter || (a.label ?? "").includes(filter))
              .map(async (acc) => {
                if (!provider) {
                  parts.push(`❌ Account[${acc.label ?? acc.planType}]: provider ${providerId} not registered`);
                  return;
                }
                const cred = provider.parseCredential(acc);
                const key = `${providerId}:${cred.accountLabel}`;
                let cached = cache.get(key);
                if (!cached) {
                  try {
                    cached = await provider.queryUsage(cred);
                    cache.set(key, cached, file.cacheTtlSeconds * 1000);
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
              });
          }),
        );
        return { content: [{ type: "text", text: parts.join("\n").trimEnd() }], details: {} };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Query failed: ${e instanceof Error ? e.message : String(e)}` },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
