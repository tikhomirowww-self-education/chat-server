import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import dynamodbConfig from 'src/config/dynamodb.config';
import { ChatType, RoomRole } from './rooms.types';

type Membership = {
  PK: string;
  SK: string;
  entity: 'MEMBERSHIP';
  userId: string;
  roomId: string;
  role: RoomRole;
  roomName: string;
  roomType: ChatType;
  createdAt: string;
  GSI1PK: string;
  GSI1SK: string;
};

type UsernameRecord = {
  PK: string;
  SK: 'USER';
  entity: 'USERNAME';
  userId: string;
  username: string;
};

type DirectPeer = {
  userId: string;
  username?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  picture?: string;
};

@Injectable()
export class RoomsService {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly userRoomsIndex: string;

  constructor(
    @Inject(dynamodbConfig.KEY)
    private readonly dbConfig: ConfigType<typeof dynamodbConfig>,
  ) {
    this.tableName = dbConfig.tableName;
    this.userRoomsIndex = dbConfig.userRoomsIndex;

    const credentials =
      dbConfig.accessKeyId && dbConfig.secretAccessKey
        ? {
            accessKeyId: dbConfig.accessKeyId,
            secretAccessKey: dbConfig.secretAccessKey,
            sessionToken: dbConfig.sessionToken,
          }
        : undefined;

    const dynamoClient = new DynamoDBClient({
      region: dbConfig.region,
      endpoint: dbConfig.endpoint,
      credentials,
    });
    this.docClient = DynamoDBDocumentClient.from(dynamoClient, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: true,
      },
    });
  }

  async getRoomsForUser(userId: string) {
    let result;
    try {
      result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: this.userRoomsIndex,
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: {
            ':pk': `USER#${userId}`,
          },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'UnrecognizedClientException') {
        throw new InternalServerErrorException(
          'Invalid AWS credentials/token for DynamoDB. Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN.',
        );
      }
      throw error;
    }

    const rooms = (result.Items ?? []).map((item) => ({
      roomId: item.roomId as string,
      roomName: item.roomName as string,
      role: item.role as RoomRole,
      roomType: item.roomType as ChatType,
    }));

    const resolved = await Promise.all(
      rooms.map(async (room) => {
        if (room.roomType !== ChatType.DIRECT) {
          return room;
        }

        const peer = await this.resolveDirectPeer(room.roomId, userId);
        return {
          ...room,
          peer,
        };
      }),
    );

    return resolved;
  }

  async createRoom(
    name: string,
    adminId: string,
    options?: { type?: ChatType; participantUsernames?: string[] },
  ) {
    const roomId = randomUUID();
    const createdAt = new Date().toISOString();
    const roomType = options?.type ?? ChatType.GROUP;
    const participantUsernames = options?.participantUsernames ?? [];
    const normalizedParticipantUsernames = Array.from(
      new Set(
        participantUsernames
          .map((username) => username.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    const resolvedParticipantIds = await Promise.all(
      normalizedParticipantUsernames.map((username) =>
        this.resolveUserIdByUsername(username),
      ),
    );
    const uniqueParticipantIds = Array.from(
      new Set(resolvedParticipantIds.filter((id) => id && id !== adminId)),
    );

    if (roomType === ChatType.DIRECT && uniqueParticipantIds.length !== 1) {
      throw new BadRequestException(
        'Direct chat must have exactly one participant',
      );
    }

    const roomName =
      roomType === ChatType.DIRECT
        ? name || normalizedParticipantUsernames[0]
        : name;

    if (!roomName) {
      throw new BadRequestException('Room name is required for group chats');
    }

    const roomItem = {
      PK: `ROOM#${roomId}`,
      SK: 'META',
      entity: 'ROOM',
      roomId,
      roomName,
      roomType,
      createdBy: adminId,
      createdAt,
    };

    const members = [adminId, ...uniqueParticipantIds];
    const memberItems: Membership[] = members.map((userId) => ({
      PK: `ROOM#${roomId}`,
      SK: `MEMBER#${userId}`,
      entity: 'MEMBERSHIP',
      userId,
      roomId,
      role: userId === adminId ? RoomRole.ADMIN : RoomRole.MEMBER,
      roomName,
      roomType,
      createdAt,
      GSI1PK: `USER#${userId}`,
      GSI1SK: `ROOM#${createdAt}#${roomId}`,
    }));

    await this.docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: roomItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...memberItems.map((item) => ({
            Put: {
              TableName: this.tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          })),
        ],
      }),
    );

    return {
      id: roomId,
      name: roomName,
      roomType,
      members: memberItems.map((member) => ({
        userId: member.userId,
        role: member.role,
      })),
    };
  }

  async deleteRoom(roomId: string, userId: string) {
    const memberKey = {
      PK: `ROOM#${roomId}`,
      SK: `MEMBER#${userId}`,
    };

    const memberRes = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: memberKey,
      }),
    );

    const member = memberRes.Item as Membership | undefined;
    if (!member || member.role !== RoomRole.ADMIN) {
      throw new BadRequestException('You are not an admin of this room');
    }

    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const queryResult = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: {
            ':pk': `ROOM#${roomId}`,
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      const items = queryResult.Items ?? [];
      const chunks = this.chunkBy(items, 25);

      for (const chunk of chunks) {
        await this.docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.tableName]: chunk.map((item) => ({
                DeleteRequest: {
                  Key: {
                    PK: item.PK as string,
                    SK: item.SK as string,
                  },
                },
              })),
            },
          }),
        );
      }

      lastEvaluatedKey = queryResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return { success: true };
  }

  async addUserToRoom(
    roomId: string,
    userId: string,
    role: RoomRole = RoomRole.MEMBER,
  ) {
    const roomMeta = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `ROOM#${roomId}`,
          SK: 'META',
        },
      }),
    );

    if (!roomMeta.Item) {
      throw new NotFoundException('Room not found');
    }

    const createdAt = new Date().toISOString();
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ROOM#${roomId}`,
          SK: `MEMBER#${userId}`,
          entity: 'MEMBERSHIP',
          roomId,
          userId,
          role,
          roomName: roomMeta.Item.roomName,
          roomType: roomMeta.Item.roomType,
          createdAt,
          GSI1PK: `USER#${userId}`,
          GSI1SK: `ROOM#${createdAt}#${roomId}`,
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );

    return {
      roomId,
      userId,
      role,
    };
  }

  async addUserToRoomByUsername(
    roomId: string,
    username: string,
    role: RoomRole = RoomRole.MEMBER,
  ) {
    const userId = await this.resolveUserIdByUsername(username);
    return this.addUserToRoom(roomId, userId, role);
  }

  async createMessage(
    roomId: string,
    userId: string,
    username: string,
    text: string,
  ) {
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new BadRequestException('Message text is required');
    }

    const membership = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `ROOM#${roomId}`,
          SK: `MEMBER#${userId}`,
        },
      }),
    );

    if (!membership.Item) {
      throw new BadRequestException('User is not a room member');
    }

    const messageId = randomUUID();
    const createdAt = new Date().toISOString();

    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ROOM#${roomId}`,
          SK: `MSG#${createdAt}#${messageId}`,
          entity: 'MESSAGE',
          messageId,
          roomId,
          userId,
          username,
          text: trimmedText,
          createdAt,
        },
      }),
    );

    return {
      id: messageId,
      roomId,
      userId,
      text: trimmedText,
      createdAt,
      user: {
        id: userId,
        displayName: username,
      },
    };
  }

  async getMessages(roomId: string) {
    const result = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :messagePrefix)',
        ExpressionAttributeValues: {
          ':pk': `ROOM#${roomId}`,
          ':messagePrefix': 'MSG#',
        },
      }),
    );

    return (result.Items ?? []).map((item) => ({
      id: item.messageId,
      text: item.text,
      userId: item.userId,
      roomId: item.roomId,
      createdAt: item.createdAt,
      user: {
        id: item.userId,
        displayName: item.username,
      },
    }));
  }

  private chunkBy<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  private async resolveUserIdByUsername(username: string): Promise<string> {
    const normalized = username.trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('Username is required');
    }

    const userLink = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USERNAME#${normalized}`,
          SK: 'USER',
        },
      }),
    );

    const record = userLink.Item as UsernameRecord | undefined;
    if (!record?.userId) {
      throw new NotFoundException(`User with username "${normalized}" not found`);
    }

    return record.userId;
  }

  private async resolveDirectPeer(
    roomId: string,
    currentUserId: string,
  ): Promise<DirectPeer | null> {
    const roomItems = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `ROOM#${roomId}`,
        },
      }),
    );

    const memberships = (roomItems.Items ?? []).filter(
      (item) => item.entity === 'MEMBERSHIP',
    );
    const peerMembership = memberships.find(
      (item) => item.userId !== currentUserId,
    );
    if (!peerMembership?.userId) {
      return null;
    }
    const peerUserId = peerMembership.userId as string;

    const profile = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${peerUserId}`,
          SK: 'PROFILE',
        },
      }),
    );

    return {
      userId: peerUserId,
      username: profile.Item?.username as string | undefined,
      displayName: profile.Item?.displayName as string | undefined,
      firstName: profile.Item?.firstName as string | undefined,
      lastName: profile.Item?.lastName as string | undefined,
      picture: profile.Item?.picture as string | undefined,
    };
  }
}
