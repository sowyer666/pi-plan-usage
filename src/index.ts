/**
 * pi-volcengine-usage — pi 扩展入口
 *
 * - /show-usage 命令：查询用量并弹出**右侧 overlay 面板**（anchor: right-center），
 *   Esc / 回车 / q 关闭。不自动轮询、不占状态栏（设计决策 D2，B 方案）
 * - query_usage 工具：供 LLM 查询用量，返回文本快照
 * - 结果缓存（默认 5 分钟）避免重复打 API
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadConfig } from "./config.ts";
import { TTLCache } from "./cache.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatWidgetLines } from "./format.ts";
// 火山方舟 provider（import 触发注册）
import "./providers/volcengine-ark/index.ts";

/** 右侧用量面板：带边框、按行着色，Esc/回车/q 关闭 */
class UsagePanel extends Container {
  private onClose: () => void;

  constructor(lines: string[], theme: any, onClose: () => void) {
    super();
    this.onClose = onClose;

    const border = (s: string) => theme.fg("accent", s);
    // 面板内容宽度（取最长行的可见宽度，限定范围）
    const inner = Math.min(
      48,
      Math.max(30, ...lines.map((l) => visibleWidth(l) + 2)),
    );

    const borderLine = border(`╭${"─".repeat(inner)}╮`);
    const borderEnd = border(`╰${"─".repeat(inner)}╯`);
    const pad = (l: string) =>
      border("│ ") +
      l +
      border(" ") +
      " ".repeat(Math.max(0, inner - visibleWidth(l) - 2)) +
      border(" │");

    this.addChild(new Text(borderLine, 0, 0));
    for (const line of lines) {
      const trimmed = line.trimStart();
      let out: string;
      if (!trimmed) {
        out = "";
      } else if (trimmed.startsWith("📊")) {
        out = theme.fg("accent", theme.bold(line));
      } else if (trimmed.startsWith("❌")) {
        out = theme.fg("error", line);
      } else if (trimmed.startsWith("未订阅") || trimmed.startsWith("未找到")) {
        out = theme.fg("muted", line);
      } else {
        out = line;
      }
      this.addChild(new Text(truncateToWidth(pad(out), inner + 4, ""), 0, 0));
    }
    this.addChild(new Text(truncateToWidth(pad(border("─".repeat(inner - 2))), inner + 4, ""), 0, 0));
    this.addChild(new Text(truncateToWidth(pad(theme.fg("dim", "Esc 关闭 / /show-usage 刷新")), inner + 4, ""), 0, 0));
    this.addChild(new Text(borderEnd, 0, 0));
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "\r" || data === "\n" || data === "q") {
      this.onClose();
    }
  }
}

export default function (pi: ExtensionAPI) {
  let panelOpen = false;
  // 缓存放在闭包里，随扩展实例生命周期存在
  let cache = new TTLCache<UsageSnapshot | Error>();

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
    description: "显示火山引擎套餐用量（右侧面板，Esc 关闭）",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("当前模式无 TUI，无法显示面板", "error");
        return;
      }
      if (panelOpen) {
        ctx.ui.notify("用量面板已打开", "info");
        return;
      }

      panelOpen = true;
      try {
        const lines = await queryAccounts();
        await ctx.ui.custom(
          (_tui, theme, _keybindings, done) => new UsagePanel(lines, theme, () => done(null)),
          {
            overlay: true,
            overlayOptions: {
              width: "45%",
              minWidth: 36,
              maxHeight: "80%",
              anchor: "right-center",
              offsetX: -1,
            },
          },
        );
      } catch (e) {
        ctx.ui.notify(`查询失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        panelOpen = false;
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
