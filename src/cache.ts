/** 带 TTL 的内存缓存（避免边栏/连续查询频繁打 API） */

interface Entry<T> {
  value: T;
  expires: number;
}

export class TTLCache<T> {
  private map = new Map<string, Entry<T>>();

  constructor(private defaultTtlMs = 300_000) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}
