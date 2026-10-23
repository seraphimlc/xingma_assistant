import { Module, forwardRef } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { AuthModule } from '../auth/auth.module';
import { LevelsModule } from '../levels/levels.module';
import { InquiriesModule } from '../inquiries/inquiries.module';
import { ProductsModule } from '../products/products.module';
import { CUSTOMERS_REPO } from './repositories/customers.repository';
import { MemoryCustomersRepository } from './repositories/memory-customers.repository';
import { TypeOrmCustomersRepository } from './repositories/typeorm-customers.repository';
import { DataSource } from 'typeorm';

const dbEnabled = process.env.DB_ENABLED === 'true';

@Module({
  imports: [AuthModule, forwardRef(() => LevelsModule), forwardRef(() => InquiriesModule), forwardRef(() => ProductsModule)],
  controllers: [CustomersController],
  providers: [
    CustomersService,
    MemoryCustomersRepository,
    {
      provide: CUSTOMERS_REPO,
      useFactory: (memory: MemoryCustomersRepository, ds?: DataSource) => {
        if (dbEnabled && ds) return new TypeOrmCustomersRepository(ds);
        return memory;
      },
      inject: [MemoryCustomersRepository, ...(dbEnabled ? [DataSource] : [])],
    },
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
