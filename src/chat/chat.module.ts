import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { RedisModule } from 'src/redis/redis.module';
import { RoomsModule } from 'src/rooms/rooms.module';
import { JwtService } from '@nestjs/jwt';
// import { RoomsProvider } from './providers/rooms.provider';

@Module({
  imports: [RedisModule, RoomsModule],
  providers: [ChatGateway, ChatService, JwtService],
})
export class ChatModule {}
