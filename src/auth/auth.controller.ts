import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import type { Response, Request } from 'express';
import { AuthType } from './auth.types';
import { SessionAuthGuard } from './guards/session-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private resolveUserId(req: Request): string {
    const user = req.user as
      | ({ sub?: string; id?: string } & Record<string, unknown>)
      | undefined;
    const userId = user?.sub ?? user?.id;
    if (!userId) {
      throw new BadRequestException('User id not found in request');
    }
    return userId;
  }

  private resolveUserIdFromSession(req: Request): string {
    const fromRequestUser =
      (req.user as { sub?: string; id?: string } | undefined)?.sub ??
      (req.user as { sub?: string; id?: string } | undefined)?.id;
    if (fromRequestUser) {
      return fromRequestUser;
    }

    const sessionInfo = req.session.user?.info as
      | ({ sub?: string; id?: string } & Record<string, unknown>)
      | undefined;
    const sessionUserId = sessionInfo?.sub ?? sessionInfo?.id;
    if (!sessionUserId) {
      throw new BadRequestException('User id not found in session');
    }
    return sessionUserId;
  }

  @Get('signUp')
  signUp(@Req() req: Request, @Res() res: Response) {
    const url = this.authService.createAuthUrl(req.session, AuthType.SIGNUP);
    return res.redirect(url);
  }

  @Get('signIn')
  signIn(@Req() req: Request, @Res() res: Response) {
    const url = this.authService.createAuthUrl(req.session, AuthType.LOGIN, undefined, {
      prompt: 'select_account',
    });
    return res.redirect(url);
  }

  @Get('profile')
  async profile(@Req() req: Request) {
    const sessionUser = req.session.user;
    if (!sessionUser) {
      return { authenticated: false };
    }

    const userId = this.resolveUserIdFromSession(req);
    const profile = await this.authService.getUserProfileById(userId);

    return {
      authenticated: true,
      user: this.authService.buildPublicProfile(sessionUser, profile),
    };
  }

  @Patch('profile')
  @UseGuards(SessionAuthGuard)
  async updateProfile(
    @Req() req: Request,
    @Body()
    body: {
      username?: string;
      firstName?: string | null;
      lastName?: string | null;
      picture?: string | null;
    },
  ) {
    if (
      body.username === undefined &&
      body.firstName === undefined &&
      body.lastName === undefined &&
      body.picture === undefined
    ) {
      throw new BadRequestException('No profile fields were provided');
    }

    const userId = this.resolveUserId(req);
    const profile = await this.authService.updateProfileForUser(userId, body);

    if (req.session.user) {
      req.session.user = this.authService.mergeProfileIntoSession(
        req.session.user,
        profile,
      );
    }

    return {
      authenticated: true,
      user: this.authService.buildPublicProfile(req.session.user!, profile),
    };
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const appUrl = this.authService.getPostLoginRedirectUrl();
    try {
      await this.authService.handleCallback(req);
      return res.redirect(appUrl);
    } catch (err) {
      console.error('Callback error:', err);
      const message =
        err instanceof Error ? err.message : 'Unknown callback error';
      return res.redirect(
        `${appUrl}/?error=auth&message=${encodeURIComponent(message)}`,
      );
    }
  }

  @Get('logout')
  @UseGuards(SessionAuthGuard)
  logout(@Req() req: Request, @Res() res: Response) {
    const idToken = req.session?.user?.id_token;

    req.session.destroy(() => {
      const logoutUrl = this.authService.generateLogoutUrl(idToken);
      res.redirect(logoutUrl);
    });
  }
}
