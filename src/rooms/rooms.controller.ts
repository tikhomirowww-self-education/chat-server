import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  Delete,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { RoomsService } from './rooms.service';
import { SessionAuthGuard } from 'src/auth/guards/session-auth.guard';
import { ChatType, RoomRole } from './rooms.types';

@Controller('rooms')
@UseGuards(SessionAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  private resolveUserId(req: Request): string {
    const user = req.user as
      | ({ sub?: string; id?: string } & Record<string, unknown>)
      | undefined;
    const userId = user?.sub ?? user?.id;
    if (!userId) {
      throw new UnauthorizedException('User id not found in request');
    }
    return userId;
  }

  @Get()
  async getRooms(@Req() req: Request) {
    const userId = this.resolveUserId(req);
    return this.roomsService.getRoomsForUser(userId);
  }

  @Post('create')
  async createRoom(
    @Req() req: Request,
    @Body()
    body: {
      name?: string;
      type?: ChatType;
      participantUsernames?: string[];
    },
  ) {
    const userId = this.resolveUserId(req);
    return this.roomsService.createRoom(body.name ?? '', userId, {
      type: body.type,
      participantUsernames: body.participantUsernames,
    });
  }

  @Post(':roomId/add')
  async addUserToRoom(
    @Param('roomId') roomId: string,
    @Body() body: { userId?: string; username?: string; role?: RoomRole },
  ) {
    if (body.username) {
      return this.roomsService.addUserToRoomByUsername(
        roomId,
        body.username,
        body.role,
      );
    }

    if (!body.userId) {
      throw new BadRequestException('userId or username is required');
    }

    return this.roomsService.addUserToRoom(roomId, body.userId, body.role);
  }

  @Get(':roomId/messages')
  async getMessages(@Param('roomId') roomId: string) {
    return this.roomsService.getMessages(roomId);
  }

  @Post(':roomId/messages')
  async createMessage(
    @Param('roomId') roomId: string,
    @Req() req: Request,
    @Body() body: { text: string },
  ) {
    const userId = this.resolveUserId(req);
    const user = req.user as
      | ({ username?: string; preferred_username?: string } & Record<
          string,
          unknown
        >)
      | undefined;

    const username =
      user?.username ??
      user?.preferred_username ??
      userId;

    return this.roomsService.createMessage(roomId, userId, username, body.text);
  }

  @Delete(':roomId')
  async deleteRoom(@Param('roomId') roomId: string, @Req() req: Request) {
    const userId = this.resolveUserId(req);
    return this.roomsService.deleteRoom(roomId, userId);
  }
}
