import { CustomerProductRuleRec, CustomerRec, FollowUpRec } from '../customer.types';

export const CUSTOMERS_REPO = 'CUSTOMERS_REPO';

export interface ICustomersRepository {
  list(
    tenantId: string,
    opts?: {
      levelId?: string;
      q?: string;
      page?: number;
      pageSize?: number;
      ids?: string[];
    },
  ): Promise<{ items: CustomerRec[]; total: number }>;
  findById(tenantId: string, id: string): Promise<CustomerRec | null>;
  findByOpenid(tenantId: string, openid: string): Promise<CustomerRec | null>;
  create(rec: Omit<CustomerRec, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date }): Promise<CustomerRec>;
  update(tenantId: string, id: string, patch: Partial<CustomerRec>): Promise<CustomerRec | null>;
  batchUpdateLevel(
    tenantId: string,
    ids: string[],
    level: { levelId: string; levelCode: string; rank: number },
  ): Promise<number>;

  listFollowUps(tenantId: string, customerId: string): Promise<FollowUpRec[]>;
  addFollowUp(
    tenantId: string,
    input: {
      customerId: string;
      authorMemberId: string;
      content: string;
      kind?: string;
      inquiryId?: string | null;
    },
  ): Promise<FollowUpRec>;
  removeFollowUp(tenantId: string, id: string): Promise<boolean>;

  listRules(tenantId: string, customerId?: string, productId?: string): Promise<CustomerProductRuleRec[]>;
  upsertRule(
    tenantId: string,
    input: { customerId: string; productId: string; effect: 'allow' | 'deny'; remark?: string | null },
  ): Promise<CustomerProductRuleRec>;
  removeRule(tenantId: string, id: string): Promise<boolean>;
  findRule(
    tenantId: string,
    customerId: string,
    productId: string,
  ): Promise<CustomerProductRuleRec | null>;
}
