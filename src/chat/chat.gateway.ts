// import {
//   WebSocketGateway,
//   WebSocketServer,
//   SubscribeMessage,
//   MessageBody,
//   ConnectedSocket,
// } from '@nestjs/websockets';
// import { Server, Socket } from 'socket.io';
// import Redis from 'ioredis';

// @WebSocketGateway({ cors: { origin: '*' } })
// export class ChatGateway {
//   @WebSocketServer() server: Server;
//   private pub = new Redis();
//   private sub = new Redis();

//   constructor() {
//     this.sub.subscribe('chat', (err) => {
//       if (err) console.error(err);
//     });

//     this.sub.on('message', (channel, message) => {
//       const { roomId, text, username } = JSON.parse(message);
//       this.server.to(roomId).emit('newMessage', { text, username, roomId });
//     });
//   }

//   @SubscribeMessage('joinRoom')
//   async handleJoin(
//     @MessageBody() roomId: string,
//     @ConnectedSocket() client: Socket,
//   ) {
//     client.join(roomId);
//   }

//   @SubscribeMessage('sendMessage')
//   async handleMessage(@MessageBody() payload: any) {
//     // payload = { roomId, userId, text, username }
//     await this.pub.publish('chat', JSON.stringify(payload));
//   }
// }

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { RoomsService } from 'src/rooms/rooms.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;

  private pub: Redis;
  private sub: Redis;
  private redisEnabled = false;

  constructor(
    private readonly roomsService: RoomsService,
    private readonly jwtService: JwtService,
  ) {
    const redisUrl = process.env.REDIS_URL?.trim();
    const redisHost = process.env.REDIS_HOST?.trim();
    const redisPort = Number(process.env.REDIS_PORT ?? '6379');
    const hasRedisConfig = Boolean(redisUrl || redisHost);

    if (hasRedisConfig) {
      const redisOptions = redisUrl
        ? redisUrl
        : {
            host: redisHost,
            port: redisPort,
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          };
      this.pub = new Redis(redisOptions as never);
      this.sub = new Redis(redisOptions as never);

      // Подписка на канал Redis "chat"
      this.sub.subscribe('chat', (err) => {
        if (err) console.error('Redis subscribe error:', err);
      });

      // Redis Pub/Sub слушает сообщения
      this.sub.on('message', (channel, message) => {
        const parsed = JSON.parse(message);
        const { roomId } = parsed;

        // Отправляем сообщение только в нужную комнату
        this.server.to(roomId).emit('newMessage', parsed);
      });
      this.redisEnabled = true;
    } else {
      console.warn(
        'Redis config was not provided (REDIS_URL or REDIS_HOST). WebSocket pub/sub fallback is local-only.',
      );
    }
  }

  // Авторизация при подключении
  handleConnection(client: Socket) {
    const token = client.handshake.auth.token;
    if (!token) return client.disconnect();

    try {
      const payload = this.jwtService.decode(token) as any;
      client.data.user = payload; // сохраняем данные пользователя
    } catch (err) {
      client.disconnect();
    }
  }

  // Присоединение к комнате
  @SubscribeMessage('joinRoom')
  async handleJoin(
    @MessageBody() roomId: string,
    @ConnectedSocket() client: Socket,
  ) {
    // Можно проверять, есть ли пользователь в комнате
    client.join(roomId);
  }

  // Отправка сообщения
  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() payload: { roomId: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = client.data.user;

    if (!user) return;

    console.log({ payload });

    const message = {
      roomId: payload.roomId,
      text: payload.text,
      username: user.preferred_username,
      userId: user.sub,
      createdAt: new Date(),
    };

    const savedMessage = await this.roomsService.createMessage(
      payload.roomId,
      user.sub,
      user.preferred_username ?? user.username ?? user.sub,
      payload.text,
    );
    console.log({ savedMessage });

    if (this.redisEnabled && this.pub) {
      // Публикуем сообщение в Redis
      await this.pub.publish(
        'chat',
        JSON.stringify({
          ...savedMessage,
          preferred_username: user.preferred_username,
        }),
      );
    } else {
      // Fallback: single-instance emit
      this.server.to(payload.roomId).emit('newMessage', {
        ...savedMessage,
        preferred_username: user.preferred_username,
      });
    }
  }
}
