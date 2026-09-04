/**
 * 火山引擎 OpenAPI V4 签名（HMAC-SHA256）
 *
 * 流程参照火山官方 SDK（SignerV4）：
 * 1. CanonicalRequest = 方法\n URI\n 规范化Query\n 规范化Headers\n SignedHeaders\n body哈希
 * 2. StringToSign = "HMAC-SHA256"\n X-Date\n CanonicalRequest哈希
 * 3. 派生密钥：kDate → kRegion → kService → kSigning（最后一轮字符串为 "request"）
 * 4. Authorization = HMAC-SHA256 Credential=AK/{date}/{region}/{service}/request, ...
 */

import { createHash, createHmac } from "node:crypto";

/** RFC3986 百分号编码（encodeURIComponent 不会转义 !'()*，需补齐） */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export interface SignInput {
  method: string;
  /** 通常为 "/" */
  path: string;
  /** query 参数（内部按 key 排序参与签名） */
  query: Record<string, string>;
  /** 会追加签名所需头（X-Date、X-Content-Sha256、Authorization） */
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  host: string;
}

export function signRequest(input: SignInput): void {
  const { method, path, query, headers, body, accessKeyId, secretAccessKey, region, service, host } = input;

  // X-Date：UTC 时间，格式 YYYYMMDDTHHMMSSZ
  const xDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const bodyHash = sha256Hex(body);

  headers["X-Date"] = xDate;
  headers["X-Content-Sha256"] = bodyHash;

  // 参与签名的头（按小写字母序）：content-type;host;x-content-sha256;x-date
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders =
    `content-type:${headers["Content-Type"]}\n` +
    `host:${host}\n` +
    `x-content-sha256:${bodyHash}\n` +
    `x-date:${xDate}\n`;

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${xDate.slice(0, 8)}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(secretAccessKey, xDate.slice(0, 8));
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers["Authorization"] =
    `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
