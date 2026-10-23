-- 租户级：客户是否可保存商品图（全局开关，非按商品）
-- 重复执行若 Duplicate column 可忽略
ALTER TABLE tenants
  ADD COLUMN allow_customer_download TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '客户是否可长按/保存商品图（全局）' AFTER contact_qr_url;
