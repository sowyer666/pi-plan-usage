/**
 * pi-volcengine-usage — pi 扩展入口
 *
 * - /show-usage 开关命令：显示 → 查询一次并在边栏（widget）展示；再执行 → 隐藏
 *   不自动轮询、不占状态栏（设计决策 D2）
 * - query_usage 工具：供 LLM 查询用量，返回文本快照
 * - 结果缓存（默认 5 分钟）避免重复打 API
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig } from "./config.ts";
import { TTLCache } from "./cache.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatWidgetLines } from "./format.ts";
// 火山方舟 provider（import 触发注册）
import "./providers/volcengine-ark/index.ts";

const WIDGET_ID = "volcengine-usage";

export default function (pi: ExtensionAPI) {
  let widgetVisible = false;
  // 缓存放在闭包里，随扩展实例生命周期存在
  let cache = new TTLCache<UsageSnapshot | Error>();

  function cacheTtlMs(): number {
    try {
      return loadConfig().cacheTtlSeconds * 1000;
    } catch {
      return 300_000;
    }
  }

  /** 查询全部（或过滤）账号，返回多行展示文本；单账号失败不影响其他账号 */
  async function queryAccounts(filter?: string): Promise<string[]> {
    const config = loadConfig();
    const ttlMs = config.cacheTtlSeconds * 1000;

    const accounts = filter
      ? config.accounts.filter((a) => (a.label ?? "").includes(filter))
      : config.accounts;
    if (accounts.length === 0) return [`未找到匹配的账号: ${filter}`];

    const lines: string[] = [];
    await Promise.allSettled(
      accounts.map(async (acc) => {
        const provider = registry.get("volcengine-ark");
        if (!provider) {
          lines.push(`❌ 账号[${acc.label ?? acc.planType}]: 供应商 volcengine-ark 未注册`);
          return;
        }
        const cred = provider.parseCredential(acc);
        const key = `${provider.id}:${cred.accountLabel}`;
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
        if (cached instanceof Error) {
          lines.push(`❌ ${cred.accountLabel}: ${cached.message}`);
        } else {
          lines.push(...formatWidgetLines(cached));
        }
        lines.push("");
      }),
    );
    return lines;
  }

  pi.registerCommand("show-usage", {
    description: "显示/隐藏火山引擎套餐用量（边栏开关）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("当前模式无 UI，无法显示边栏", "error");
        return;
      }

      // 开关：已显示 → 隐藏
      if (widgetVisible) {
        widgetVisible = false;
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }

      widgetVisible = true;
      ctx.ui.setWidget(WIDGET_ID, ["📊 正在查询用量…"]);

      try {
        const lines = await queryAccounts();
        if (widgetVisible) ctx.ui.setWidget(WIDGET_ID, lines);
      } catch (e) {
        if (widgetVisible) {
          ctx.ui.setWidget(WIDGET_ID, [
            `❌ 查询失败: ${e instanceof Error ? e.message : String(e)}`,
            "修复配置后再次执行 /show-usage 重查",
          ]);
        }
      }
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
        const lines = await queryAccounts(params?.account);
        return {
          content: [{ type: "text", text: lines.join("\n").trimEnd() }],
          details: {},
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `查询失败: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
