import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth.service';

type RequestWithUser = Request & {
  user?: Record<string, unknown> & { sub?: string; id?: string };
};

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();

    if (!req.session?.user) {
      throw new UnauthorizedException('User is not authenticated');
    }

    await this.authService.refreshSessionIfNeeded(req);

    if (!req.session.user) {
      throw new UnauthorizedException('Session is expired');
    }

    const sessionInfo = req.session.user.info ?? {};
    const sub =
      typeof sessionInfo.sub === 'string'
        ? sessionInfo.sub
        : typeof sessionInfo['sub'] === 'string'
          ? sessionInfo['sub']
          : undefined;

    req.user = {
      ...sessionInfo,
      ...(req.session.user.username
        ? { username: req.session.user.username }
        : {}),
      ...(sub ? { sub, id: sub } : {}),
    };

    return true;
  }
}
