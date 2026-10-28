-- Hot-path indexes for staff product/job/customer list pages (2026-10-28)
-- Safe to re-run: ignore Duplicate key name errors.

-- products: staff list filters by tenant + status/group, order by created_at
ALTER TABLE products
  ADD INDEX idx_products_tenant_status_created (tenant_id, status, created_at);

ALTER TABLE products
  ADD INDEX idx_products_tenant_group_status_created (tenant_id, group_id, status, created_at);

-- product_skus: batch listSkusByProductIds
ALTER TABLE product_skus
  ADD INDEX idx_skus_tenant_product_status (tenant_id, product_id, status);

-- promo_sets: orphan failed append on jobs list
ALTER TABLE promo_sets
  ADD INDEX idx_promo_sets_tenant_status_updated (tenant_id, status, updated_at);

-- inquiries unreadSummary group by customer
ALTER TABLE inquiries
  ADD INDEX idx_inquiries_tenant_customer_status (tenant_id, customer_id, status);
