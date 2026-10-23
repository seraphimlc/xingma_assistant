import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** 租户（一个微信小程序 AppID 对应一个档口/业主） */
@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, name: 'wx_app_id', comment: '微信小程序 AppID' })
  wxAppId!: string;

  @Column({ type: 'varchar', length: 128, name: 'wx_app_secret', comment: '小程序 AppSecret（加密存储）', select: false })
  wxAppSecret!: string;

  @Column({ type: 'varchar', length: 128, comment: '档口名称' })
  name!: string;

  @Column({ type: 'varchar', length: 32, default: 'active', comment: '状态: active|suspended' })
  status!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'oss_prefix', comment: '对象存储目录前缀' })
  ossPrefix!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'contact_qr_url', comment: '业主微信二维码 URL' })
  contactQrUrl!: string | null;

  @Column({ type: 'tinyint', width: 1, name: 'allow_customer_download', default: 0, comment: '客户是否可长按/保存商品图（全局）' })
  allowCustomerDownload!: boolean;

  /** 预留：微信第三方平台授权方 appid */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'authorizer_appid', comment: '第三方平台授权 AppID' })
  authorizerAppid!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
