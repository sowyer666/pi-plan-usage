/**
 * 配置加载：插件目录下 config/<平台>.json（先只有 volcengine.json）
 * 值支持 "$ENV_VAR" 形式引用环境变量，避免明文落盘。
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
}

/** 插件根目录（src 的上一级） */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** 展开 "$VAR" 形式的环境变量引用 */
export function expandEnv(value: string): string {
  if (value.startsWith("$")) {
    const name = value.slice(1);
    const v = process.env[name];
    if (!v) throw new Error(`环境变量 ${name} 未设置（配置中引用为 ${value}）`);
    return v;
  }
  return value;
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
  };
}
