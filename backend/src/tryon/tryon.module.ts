import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { DecartTokenClient } from './decart-token.client';
import { TryonController } from './tryon.controller';
import { TryonService } from './tryon.service';

@Module({
  imports: [AuthModule, ProductsModule],
  controllers: [TryonController],
  providers: [TryonService, DecartTokenClient],
})
export class TryonModule {}
