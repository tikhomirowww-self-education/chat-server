import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { RedisModule } from './redis/redis.module';
import { ChatModule } from './chat/chat.module';
import { AuthModule } from './auth/auth.module';
import { RoomsModule } from './rooms/rooms.module';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
import authConfig from './config/auth.config';
import dynamodbConfig from './config/dynamodb.config';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', 'server/.env'],
      load: [authConfig, dynamodbConfig],
      validationSchema: envValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    RedisModule, ChatModule, AuthModule, RoomsModule,
  ],
  controllers: [HealthController],
  providers: [AppService],
})
export class AppModule {}
