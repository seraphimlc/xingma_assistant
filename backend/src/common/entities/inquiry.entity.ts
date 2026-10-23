import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 询价：关联单商品；可附带联系方式 */
@Entity('inquiries')
export class Inquiry extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'text', comment: '询价内容' })
  content!: string;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '询价时留下的手机' })
  phone!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'contact_name', comment: '询价时留下的姓名/称呼' })
  contactName!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '可选备注' })
  remark!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'open', comment: 'open|handled|replied|closed' })
  status!: string;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'assignee_member_id' })
  assigneeMemberId!: string | null;

  /** 员工已读时间；NULL=未读（客户新提交默认未读） */
  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'staff_read_at' })
  staffReadAt!: Date | null;

  /** 处理方式说明（点「已处理」时填写） */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'handled_note' })
  handledNote!: string | null;
}
