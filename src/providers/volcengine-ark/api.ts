/**
 * 火山方舟 OpenAPI 调用（管控面，AK/SK 签名）
 *
 * 套餐额度查询（参照官方 ark-cli 的 usage plan 底层接口）：
 * - Coding Plan：Action = GetCodingPlanUsage
 * - Agent Plan：Action = GetAFPUsage
 */

import { signRequest, uriEncode } from "./sign.ts";

const HOST = "open.volcengineapi.com";
const REGION = "cn-beijing";
const SERVICE = "ark";
const VERSION = "2024-01-01";

export interface ArkCallCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

/** 调用方舟管控面 OpenAPI，返回解析后的 JSON（含 ResponseMetadata / Result） */
export async function callArkOpenAPI(
  cred: ArkCallCredential,
  action: string,
  signal?: AbortSignal,
): Promise<unknown> {
  // query 按字母序：Action < Region < Version
  const query: Record<string, string> = {
    Action: action,
    Region: REGION,
    Version: VERSION,
  };

  const body = "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };

  signRequest({
    method: "POST",
    path: "/",
    query,
    headers,
    body,
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
    region: REGION,
    service: SERVICE,
    host: HOST,
  });

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const url = `https://${HOST}/?${canonicalQuery}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal });
  } catch (e) {
    throw new Error(`Network request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`HTTP ${res.status} response is not JSON: ${text.slice(0, 200)}`);
  }

  const meta = data?.ResponseMetadata as Record<string, unknown> | undefined;
  const err = meta?.Error as Record<string, unknown> | undefined;
  if (err) {
    throw new Error(`Volcengine OpenAPI error ${err.Code}: ${err.Message}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}
