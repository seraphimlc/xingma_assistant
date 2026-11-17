import './load-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 本地落盘始终保留（OCR/封面）；OSS_PROVIDER=aliyun 时 API 返回 OSS URL。
  // MEDIA_SERVE_LOCAL=1 时可强制回退 /media/ 假 CDN（微信未配 OSS 合法域名时）
  const storageRoot = join(__dirname, '..', 'storage');
  app.useStaticAssets(storageRoot, { prefix: '/media/' });
  logger.log(`本地媒体目录: ${storageRoot} → /media/ (OSS=${process.env.OSS_PROVIDER || 'mock'})`);
  const tryOnRoot = join(__dirname, '..', 'public');
  app.useStaticAssets(tryOnRoot, { prefix: '/', index: 'index.html' });
  logger.log(`试衣页: ${tryOnRoot}/tryon/ → /tryon/`);
  // 骨架阶段关闭 whitelist，避免未加 class-validator 装饰器的 DTO 字段被剥掉
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      forbidNonWhitelisted: false,
    }),
  );
  app.enableCors({ origin: true });
  const port = process.env.PORT || 3000;
  const host = process.env.LISTEN_HOST || '127.0.0.1';
  await app.listen(port, host);
  logger.log(`羊毛衫档口 API 已启动: http://127.0.0.1:${port}（对外 ${process.env.APP_BASE_URL || '-'}）`);
  logger.log(`DEV_FAKE_LOGIN=${process.env.DEV_FAKE_LOGIN === 'true'} WECHAT_APP_SECRET=${process.env.WECHAT_APP_SECRET ? '已配置' : '未配置'}`);
  logger.log(`DB_ENABLED=${process.env.DB_ENABLED || 'false'}（false 时使用内存占位服务）`);
}
bootstrap();
