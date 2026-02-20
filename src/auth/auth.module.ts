import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ConfigModule } from '@nestjs/config';
import authConfig from 'src/config/auth.config';
import { SessionAuthGuard } from './guards/session-auth.guard';
import dynamodbConfig from 'src/config/dynamodb.config';

@Module({
  imports: [ConfigModule.forFeature(authConfig), ConfigModule.forFeature(dynamodbConfig)],
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
