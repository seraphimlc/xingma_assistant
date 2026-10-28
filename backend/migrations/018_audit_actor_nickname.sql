-- 审计日志：操作人昵称快照（便于按人检索；不回填历史）
-- 可重复执行：列已存在时 ALTER 会失败，部署脚本应容错

ALTER TABLE audit_logs
  ADD COLUMN actor_nickname VARCHAR(64) NULL COMMENT '操作人昵称快照' AFTER actor_role;

ALTER TABLE audit_logs
  ADD KEY idx_audit_actor_member (tenant_id, actor_member_id, created_at);
