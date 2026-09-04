/**
 * CLI 调试入口：独立跑通 provider 查询
 *
 * 用法：
 *   node src/cli.ts                # 查询全部供应商全部账号
 *   node src/cli.ts ark            # 只查指定 provider（短名）
 *   node src/cli.ts ark Coding     # 再按 label 过滤（包含匹配）
 */

import { loadAllConfigs } from "./config.ts";
import { registry, type UsageSnapshot } from "./providers/types.ts";
import { formatSnapshotText } from "./format.ts";
import "./providers/volcengine-ark/index.ts";

function providerIdFor(shortName: string): string {
  for (const [id, p] of registry) {
    if (p.shortName === shortName || id === shortName || id.endsWith(`-${shortName}`)) return id;
  }
  return shortName;
}

async function main(): Promise<void> {
  const [providerToken, labelFilter] = process.argv.slice(2);
  const config = loadAllConfigs();

  const files = providerToken
    ? config.providers.filter((p) => p.shortName === providerToken.toLowerCase())
    : config.providers;
  if (files.length === 0) {
    console.error(`No matching provider: ${providerToken} (available: ${config.providers.map((p) => p.shortName).join(", ")})`);
    process.exit(1);
  }

  const jobs: { name: string; run: () => Promise<string> }[] = [];
  for (const file of files) {
    const providerId = providerIdFor(file.shortName);
    const provider = registry.get(providerId);
    for (const acc of file.accounts) {
      if (labelFilter && !(acc.label ?? "").includes(labelFilter)) continue;
      const name = acc.label ?? acc.planType;
      jobs.push({
        name,
        run: async () => {
          if (!provider) throw new Error(`provider ${providerId} not registered`);
          const cred = provider.parseCredential(acc);
          const snap: UsageSnapshot = await provider.queryUsage(cred);
          return formatSnapshotText(snap);
        },
      });
    }
  }
  if (jobs.length === 0) {
    console.error(`No matching account: ${labelFilter}`);
    process.exit(1);
  }

  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(r.status === "fulfilled" ? r.value : `❌ ${jobs[i].name}: ${r.reason?.message ?? r.reason}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("Query failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
