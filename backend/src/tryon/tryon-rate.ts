/** 进程内滑动窗口。单实例 wool-api 够用；重启后计数清零。 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const prev = this.hits.get(key) || [];
    const fresh = prev.filter((ts) => now - ts < windowMs);
    if (fresh.length >= limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    if (this.hits.size > 5000) {
      for (const [k, arr] of this.hits) {
        if (!arr.some((ts) => now - ts < windowMs)) this.hits.delete(k);
        if (this.hits.size <= 4000) break;
      }
    }
    return true;
  }
}
