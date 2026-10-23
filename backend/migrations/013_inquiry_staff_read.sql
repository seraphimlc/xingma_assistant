-- 员工已读标记 + 处理说明
-- staff_read_at NULL=未读（客户新提交默认未读）；打开客户详情后置为当前时间
-- handled_note：员工点「已处理」时填写的处理方式说明；status 置为 handled
ALTER TABLE inquiries
  ADD COLUMN staff_read_at DATETIME(6) NULL COMMENT '员工已读时间；NULL=未读' AFTER assignee_member_id,
  ADD COLUMN handled_note VARCHAR(512) NULL COMMENT '处理方式说明' AFTER staff_read_at,
  ADD KEY idx_inq_staff_unread (tenant_id, staff_read_at);
