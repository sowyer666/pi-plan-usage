/**
 * 配置加载：插件目录下 config/<短名>.json，按供应商一个文件。
 * 文件名（不含扩展名）即 provider 短名，如 ark.json → volcengine-ark。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProviderAccountConfig {
  label?: string;
  /** 供应商内的套餐类型，如 coding | agent（语义由 provider 定义） */
  planType: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** 单个供应商配置文件的内容 */
export interface ProviderFileConfig {
  /** 文件名（不含扩展名）= provider 短名，如 "ark" */
  shortName: string;
  accounts: ProviderAccountConfig[];
  cacheTtlSeconds: number;
  refreshIntervalSeconds: number;
}

export interface PluginConfig {
  providers: ProviderFileConfig[];
  cacheTtlSeconds: number;
  refreshIntervalSeconds: number;
}

/** 插件根目录（src 的上一级） */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function configDir(): string {
  return join(pluginRoot(), "config");
}

export function loadAllConfigs(): PluginConfig {
  const dir = configDir();
  if (!existsSync(dir)) {
    throw new Error(
      `Config directory not found: ${dir}\n` +
        `Copy config/ark.example.json to config/ark.json and fill in AK/SK`,
    );
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"))
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No provider config in ${dir}\n` +
        `Copy config/ark.example.json to config/ark.json and fill in AK/SK`,
    );
  }

  const providers: ProviderFileConfig[] = [];
  for (const file of files) {
    const shortName = file.replace(/\.json$/, "");
    const raw = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<string, unknown>;
    const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []) as ProviderAccountConfig[];
    if (accounts.length === 0) {
      throw new Error(`config/${file}: accounts is empty`);
    }
    providers.push({
      shortName,
      accounts,
      cacheTtlSeconds: typeof raw.cacheTtlSeconds === "number" ? raw.cacheTtlSeconds : 300,
      refreshIntervalSeconds:
        typeof raw.refreshIntervalSeconds === "number" && raw.refreshIntervalSeconds > 0
          ? raw.refreshIntervalSeconds
          : 120,
    });
  }

  return {
    providers,
    // 全局刷新间隔取所有文件中的最小值（任何一个供应商想要更高频率就满足它）
    cacheTtlSeconds: Math.min(...providers.map((p) => p.cacheTtlSeconds)),
    refreshIntervalSeconds: Math.min(...providers.map((p) => p.refreshIntervalSeconds)),
  };
}
