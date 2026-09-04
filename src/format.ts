/**
 * 用量快照格式化：边栏多行 / 文本输出共用
 */

import type { UsageSnapshot, UsageWindow } from "./providers/types.ts";

/** 渲染进度条：优先 percent，其次 used/total */
export function renderBar(w: UsageWindow, width = 10): string {
  let ratio: number;
  if (w.percent !== undefined) {
    ratio = w.percent / 100;
  } else if (w.used !== undefined && w.total) {
    ratio = w.used / w.total;
  } else {
    ratio = 0;
  }
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** 相对时间：如 "4h12m"、"30m"（未来）/ "10m前"（过去） */
export function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return "";
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const span = h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
  return diff >= 0 ? span : `${span}前`;
}

/** 窗口描述：如 "320/1200 · 4h12m重置" 或 "42%" */
export function describeWindow(w: UsageWindow): string {
  const parts: string[] = [];
  if (w.used !== undefined && w.total !== undefined) {
    parts.push(`${w.used}/${w.total}`);
  } else if (w.percent !== undefined) {
    parts.push(`${Math.round(w.percent)}%`);
  } else if (w.used !== undefined) {
    parts.push(`${w.used}`);
  }
  if (w.resetAt) {
    const rt = relativeTime(w.resetAt);
    if (rt) parts.push(`${rt}重置`);
  }
  return parts.join(" · ");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** 快照 → 边栏多行文本 */
export function formatWidgetLines(snapshot: UsageSnapshot): string[] {
  const lines: string[] = [];
  const head = `📊 ${snapshot.accountLabel}（${snapshot.planType}${snapshot.tier ? " · " + snapshot.tier : ""}）`;
  lines.push(head);

  if (!snapshot.subscribed) {
    lines.push("  未订阅套餐或无用量数据");
    return lines;
  }

  for (const w of snapshot.windows) {
    lines.push(`  ${pad(w.label, 9)}${renderBar(w)} ${describeWindow(w)}`);
  }
  return lines;
}

/** 快照 → 状态栏紧凑单行（不含账号标签）；标签 d/w/m，百分比保留 1 位小数 */
export function formatCompactLine(snapshot: UsageSnapshot): string {
  if (!snapshot.subscribed) return "未订阅";
  return snapshot.windows
    .map((w) => {
    const label =
      w.kind === "rolling5h" ? "5h" : w.kind === "daily" ? "d" : w.kind === "weekly" ? "w" : w.kind === "monthly" ? "m" : w.label;
    // 优先用 used/total 精确计算，保留 1 位小数
    const pct =
      w.used !== undefined && w.total
        ? (w.used / w.total) * 100
        : w.percent !== undefined
          ? w.percent
          : undefined;
    const reset = w.resetAt ? relativeTime(w.resetAt) : "";
    return `${label}${pct !== undefined ? ` ${pct.toFixed(1)}%` : ""}${reset ? `·${reset}` : ""}`;
  })
    .join(" ");
}

/** 快照 → 单段文本 */
export function formatSnapshotText(snapshot: UsageSnapshot): string {
  return formatWidgetLines(snapshot).join("\n");
}
