import { Module, forwardRef } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductAccessService } from './product-access.service';
import { AuthModule } from '../auth/auth.module';
import { LevelsModule } from '../levels/levels.module';
import { PRODUCTS_REPO } from './repositories/products.repository';
import { MemoryProductsRepository } from './repositories/memory-products.repository';
import { TypeOrmProductsRepository } from './repositories/typeorm-products.repository';
import { DataSource } from 'typeorm';
import { PublishController } from './publish/publish.controller';
import { PublishService } from './publish/publish.service';
import { ProductGroupsService } from './product-groups.service';
import { ProductGroupsController } from './product-groups.controller';
import { JobsModule } from '../jobs/jobs.module';
import { TenantsModule } from '../tenants/tenants.module';

const dbEnabled = process.env.DB_ENABLED === 'true';

@Module({
  imports: [AuthModule, forwardRef(() => LevelsModule), forwardRef(() => JobsModule), TenantsModule],
  controllers: [ProductsController, PublishController, ProductGroupsController],
  providers: [
    ProductsService,
    PublishService,
    ProductGroupsService,
    ProductAccessService,
    MemoryProductsRepository,
    {
      provide: PRODUCTS_REPO,
      useFactory: (memory: MemoryProductsRepository, ds?: DataSource) => {
        if (dbEnabled && ds) return new TypeOrmProductsRepository(ds);
        return memory;
      },
      inject: [MemoryProductsRepository, ...(dbEnabled ? [DataSource] : [])],
    },
  ],
  exports: [ProductsService, ProductAccessService, PublishService, ProductGroupsService],
})
export class ProductsModule {}
