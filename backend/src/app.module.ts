import { MiddlewareConsumer, Module, NestModule, DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { ProductsModule } from './products/products.module';
import { CustomersModule } from './customers/customers.module';
import { LevelsModule } from './levels/levels.module';
import { SharesModule } from './shares/shares.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { MediaModule } from './media/media.module';
import { LoginModule } from './login/login.module';
import { PromoModule } from './promo/promo.module';
import { InvitesModule } from './invites/invites.module';
import { JobsModule } from './jobs/jobs.module';
import { TryonModule } from './tryon/tryon.module';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import * as entities from './common/entities';

const entityList = Object.values(entities).filter(
  (e) => typeof e === 'function',
) as Function[];

function buildTypeOrm(): DynamicModule {
  if (process.env.DB_ENABLED === 'true') {
    return TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql' as const,
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.name'),
        entities: entityList,
        synchronize: false,
        logging: config.get<string>('nodeEnv') === 'development',
      }),
    });
  }
  return {
    module: class TypeOrmSkippedModule {},
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    buildTypeOrm(),
    CommonModule,
    AuthModule,
    TenantsModule,
    LevelsModule,
    ProductsModule,
    CustomersModule,
    SharesModule,
    InquiriesModule,
    MediaModule,
    LoginModule,
    JobsModule,
    PromoModule,
    InvitesModule,
    TryonModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
