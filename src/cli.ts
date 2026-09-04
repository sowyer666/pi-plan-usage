/**
 * CLI 调试入口（M1：独立跑通 provider 查询）
 *
 * 用法：
 *   node src/cli.ts            # 查询全部账号
 *   node src/cli.ts Coding     # 按 label 过滤（包含匹配）
 */

import { loadConfig } from "./config.ts";
import { volcengineArkProvider } from "./providers/volcengine-ark/index.ts";
import { formatSnapshotText } from "./format.ts";

async function main(): Promise<void> {
  const filter = process.argv[2];
  const config = loadConfig();

  const accounts = filter
    ? config.accounts.filter((a) => (a.label ?? "").includes(filter))
    : config.accounts;
  if (accounts.length === 0) {
    console.error(`No matching account: ${filter}`);
    process.exit(1);
  }

  const results = await Promise.allSettled(
    accounts.map(async (acc) => {
      const cred = volcengineArkProvider.parseCredential(acc);
      const snap = await volcengineArkProvider.queryUsage(cred);
      return formatSnapshotText(snap);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = accounts[i].label ?? accounts[i].planType;
    console.log(r.status === "fulfilled" ? r.value : `❌ ${name}: ${r.reason?.message ?? r.reason}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("Query failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
