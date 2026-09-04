/**
 * 配置加载：插件目录下 config/<平台>.json（先只有 volcengine.json）
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VolcengineAccountConfig {
  label?: string;
  /** coding | agent */
  planType: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PluginConfig {
  accounts: VolcengineAccountConfig[];
  cacheTtlSeconds: number;
  /** 状态栏自动刷新间隔（秒），默认 120 */
  refreshIntervalSeconds: number;
}

/** 插件根目录（src 的上一级） */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadConfig(): PluginConfig {
  const path = join(pluginRoot(), "config", "volcengine.json");
  if (!existsSync(path)) {
    throw new Error(
      `配置文件不存在: ${path}\n请复制 config/volcengine.example.json 为 config/volcengine.json 并填写 AK/SK`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []) as VolcengineAccountConfig[];
  if (accounts.length === 0) {
    throw new Error("config/volcengine.json 中 accounts 为空");
  }
  return {
    accounts,
    cacheTtlSeconds: typeof raw.cacheTtlSeconds === "number" ? raw.cacheTtlSeconds : 300,
    refreshIntervalSeconds:
      typeof raw.refreshIntervalSeconds === "number" && raw.refreshIntervalSeconds > 0
        ? raw.refreshIntervalSeconds
        : 120,
  };
}
