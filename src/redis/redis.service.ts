import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private publisher: Redis;
  private subscriber: Redis;
  private enabled = false;

  constructor(private readonly emitter: EventEmitter2) {}

  async onModuleInit() {
    const redisUrl = process.env.REDIS_URL?.trim();
    const redisHost = process.env.REDIS_HOST?.trim();
    const redisPort = Number(process.env.REDIS_PORT ?? '6379');
    const hasRedisConfig = Boolean(redisUrl || redisHost);

    if (!hasRedisConfig) {
      console.warn(
        'Redis config was not provided (REDIS_URL or REDIS_HOST). Redis pub/sub is disabled.',
      );
      return;
    }

    const redisOptions = redisUrl
      ? redisUrl
      : {
          host: redisHost,
          port: redisPort,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        };

    this.publisher = new Redis(redisOptions as never);
    this.subscriber = new Redis(redisOptions as never);

    await this.subscriber.subscribe('chat');
    this.enabled = true;
    console.log('✅ Redis subscribed to chat channel');

    this.subscriber.on('message', (channel, message) => {
      console.log(`📨 Redis message: ${message}`);
      this.emitter.emit('chat.message', JSON.parse(message));
    });

    this.publisher.on('error', (error) => {
      console.error('Redis publisher error:', error);
    });
    this.subscriber.on('error', (error) => {
      console.error('Redis subscriber error:', error);
    });
  }

  async publish(message: any) {
    if (!this.enabled || !this.publisher) {
      return;
    }
    await this.publisher.publish('chat', JSON.stringify(message));
  }

  async onModuleDestroy() {
    if (this.publisher) {
      await this.publisher.quit();
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
  }
}
