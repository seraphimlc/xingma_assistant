-- 询价附带联系方式（手机/姓名），便于客服回拨；可空（旧记录）
ALTER TABLE inquiries
  ADD COLUMN phone VARCHAR(32) NULL COMMENT '询价时留下的手机' AFTER content,
  ADD COLUMN contact_name VARCHAR(64) NULL COMMENT '询价时留下的姓名/称呼' AFTER phone,
  ADD COLUMN remark VARCHAR(255) NULL COMMENT '可选备注' AFTER contact_name;
