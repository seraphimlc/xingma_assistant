/**
 * 媒体展示 URL 稳定化（OSS 公网读切换后）。
 * 历史数据可能把「短时签名 GET」整串写入 avatar_url / contact_qr_url；
 * 签名过期后小程序 <image> 空白。公网读桶应剥掉签名 query，只留永久对象地址。
 * 商品图走 objectKey → publicUrl，无此问题；头像/联系二维码存的是完整 URL，须在读写时归一。
 */
export function stableMediaUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  const raw = String(url).trim();
  if (!raw) return null;

  // 小程序本地临时路径不可入库/展示为网络图
  if (
    /^wxfile:/i.test(raw) ||
    /^file:/i.test(raw) ||
    /^http:\/\/(tmp|usr)\//i.test(raw) ||
    /^\/(tmp|usr)\//i.test(raw)
  ) {
    return null;
  }

  // OSS V1/V2 签名参数：公网读下保留会 403（Request has expired）
  if (
    /[?&](OSSAccessKeyId|Signature|Expires|security-token|x-oss-signature|x-oss-credential|x-oss-date|x-oss-expires|x-oss-signature-version)=/i.test(
      raw,
    )
  ) {
    const q = raw.indexOf('?');
    return q >= 0 ? raw.slice(0, q) : raw;
  }
  return raw;
}

/** 是否可接受的已上传媒体地址（https 或本站 /media） */
export function isStableUploadedMediaUrl(url: string): boolean {
  const u = String(url || '').trim();
  if (!u) return false;
  const stable = stableMediaUrl(u);
  const check = stable || u;
  return (
    /^https:\/\//i.test(check) ||
    /^\/media\//i.test(check) ||
    /^https?:\/\/[^/]+\/media\//i.test(check)
  );
}


/** 是否已是绝对 http(s) URL（含误拼成 OSS/prefix + https 的双前缀） */
export function isAbsoluteHttpUrl(value: string | null | undefined): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  // 历史双前缀：https://xy-tradex.../xingma-stall/https://other...
  return /\/https?:\/\//i.test(raw);
}

/**
 * 归一 objectKey / URL：
 * - 已是 http(s) → 若含双前缀则抽出内层绝对 URL
 * - 相对 key 误含嵌套 http(s) → 抽出内层
 * - 其它相对 key → 原样（由 publicUrl/fullKey 再拼）
 */
export function unwrapAbsoluteMediaUrl(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    // 双前缀：https://own-oss/.../https://upstream...
    const inner = raw.match(/https?:\/\/[^\s]+?\/(https?:\/\/.+)$/i);
    if (inner) return inner[1];
    return raw;
  }
  const embedded = raw.match(/(https?:\/\/.+)$/i);
  if (embedded && /https?:\/\//i.test(raw)) return embedded[1];
  return raw;
}
