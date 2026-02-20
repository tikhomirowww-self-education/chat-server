import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  Client,
  generators,
  Issuer,
  TokenSet,
  UserinfoResponse,
} from 'openid-client';
import type { Request } from 'express';
import type { Session, SessionData } from 'express-session';
import { AuthType } from './auth.types';
import authConfiguration from 'src/config/auth.config';
import dynamodbConfig from 'src/config/dynamodb.config';

type SessionUser = NonNullable<SessionData['user']>;
type UserProfileItem = {
  PK: string;
  SK: 'PROFILE';
  entity: 'USER_PROFILE';
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  picture?: string;
  email?: string;
  createdAt?: string;
  updatedAt?: string;
};

type UpdateProfileInput = {
  username?: string;
  firstName?: string | null;
  lastName?: string | null;
  picture?: string | null;
};

@Injectable()
export class AuthService {
  private client: Client;
  private redirectUri: string;
  private postLogoutRedirectUri: string;
  private usersDocClient: DynamoDBDocumentClient;
  private usersTableName: string;

  constructor(
    @Inject(authConfiguration.KEY)
    private readonly authConfig: ConfigType<typeof authConfiguration>,
    @Inject(dynamodbConfig.KEY)
    private readonly dbConfig: ConfigType<typeof dynamodbConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    const issuer = await Issuer.discover(this.authConfig.cognitoIssuerUrl);

    this.redirectUri = this.authConfig.redirectUri;
    this.postLogoutRedirectUri = this.authConfig.postLogoutRedirectUri;

    this.client = new issuer.Client({
      client_id: this.authConfig.clientId,
      client_secret: this.authConfig.clientSecret,
      redirect_uris: [this.redirectUri],
      response_types: ['code'],
    });

    this.usersTableName = this.dbConfig.tableName;

    const credentials =
      this.dbConfig.accessKeyId && this.dbConfig.secretAccessKey
        ? {
            accessKeyId: this.dbConfig.accessKeyId,
            secretAccessKey: this.dbConfig.secretAccessKey,
            sessionToken: this.dbConfig.sessionToken,
          }
        : undefined;

    const usersDynamoClient = new DynamoDBClient({
      region: this.dbConfig.region,
      endpoint: this.dbConfig.endpoint,
      credentials,
    });
    this.usersDocClient = DynamoDBDocumentClient.from(usersDynamoClient, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: true,
      },
    });
  }

  createAuthUrl(
    session: Session & Partial<SessionData>,
    authType: AuthType = AuthType.LOGIN,
    identityProvider?: string,
    options?: { prompt?: 'login' | 'consent' | 'select_account' },
  ): string {
    const nonce = generators.nonce();
    const state = generators.state();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    session.nonce = nonce;
    session.state = state;
    session.codeVerifier = codeVerifier;

    const scope = this.authConfig.scope;

    const url = this.client.authorizationUrl({
      scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      identity_provider: identityProvider,
      ...(options?.prompt ? { prompt: options.prompt } : {}),
    });

    return authType === AuthType.LOGIN
      ? url
      : url.replace('/oauth2/authorize', '/signup');
  }

  async handleCallback(
    req: Request,
  ): Promise<{ tokenSet: TokenSet; userInfo: UserinfoResponse }> {
    const params = this.client.callbackParams(req.originalUrl);
    const oauthError = params.error as string | undefined;
    if (oauthError) {
      const description = (params.error_description as string | undefined) ?? '';
      throw new Error(
        `OAuth callback error: ${oauthError}${description ? ` - ${description}` : ''}`,
      );
    }

    if (!req.session?.state || !req.session?.nonce || !req.session?.codeVerifier) {
      throw new Error(
        'Missing OAuth session state/nonce/codeVerifier. Session cookie was likely lost before callback.',
      );
    }

    const tokenSet = await this.client.callback(
      this.redirectUri,
      params,
      {
        nonce: req.session.nonce,
        state: req.session.state,
        code_verifier: req.session.codeVerifier,
      },
    );
    
    const userInfo = await this.client.userinfo(tokenSet);
    const username = await this.ensureUserProfile(userInfo);
    req.session.user = {
      info: userInfo,
      id_token: tokenSet.id_token,
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: tokenSet.expires_at,
      username,
    };
    delete req.session.nonce;
    delete req.session.state;
    delete req.session.codeVerifier;

    return { tokenSet, userInfo };
  }

  async refreshSessionIfNeeded(req: Request): Promise<void> {
    const sessionUser = req.session.user;
    if (!sessionUser) return;

    if (!sessionUser.refresh_token || !sessionUser.expires_at) return;

    const nowInSeconds = Math.floor(Date.now() / 1000);
    const shouldRefresh = sessionUser.expires_at <= nowInSeconds + 30;
    if (!shouldRefresh) return;

    try {
      const refreshedTokenSet = await this.client.refresh(sessionUser.refresh_token);

      req.session.user = {
        ...sessionUser,
        id_token: refreshedTokenSet.id_token ?? sessionUser.id_token,
        access_token: refreshedTokenSet.access_token ?? sessionUser.access_token,
        refresh_token: refreshedTokenSet.refresh_token ?? sessionUser.refresh_token,
        expires_at: refreshedTokenSet.expires_at ?? sessionUser.expires_at,
      };
    } catch (error) {
      delete req.session.user;
      throw new Error('Failed to refresh access token');
    }
  }

  generateLogoutUrl(idToken?: string): string {
    const endSessionEndpoint = this.client.issuer.metadata.end_session_endpoint;
    if (!endSessionEndpoint) {
      throw new Error('OIDC end_session_endpoint is not configured for issuer');
    }

    const logoutUrl = new URL(endSessionEndpoint);
    logoutUrl.searchParams.set('client_id', this.client.metadata.client_id);
    logoutUrl.searchParams.set('logout_uri', this.postLogoutRedirectUri);

    if (idToken) {
      logoutUrl.searchParams.set('id_token_hint', idToken);
    }

    return logoutUrl.toString();
  }

  getPostLoginRedirectUrl(): string {
    return this.postLogoutRedirectUri;
  }

  buildPublicProfile(
    sessionUser: SessionUser,
    profile?: UserProfileItem | null,
  ): Record<string, unknown> {
    const info = sessionUser.info ?? {};
    const firstName = profile
      ? profile.firstName
      : (typeof info.given_name === 'string' ? info.given_name : undefined);
    const lastName = profile
      ? profile.lastName
      : (typeof info.family_name === 'string' ? info.family_name : undefined);
    const displayName =
      profile?.displayName ??
      this.buildDisplayName(
        firstName,
        lastName,
        typeof info.name === 'string' ? info.name : undefined,
        profile?.username ??
          sessionUser.username ??
          (typeof info.preferred_username === 'string'
            ? info.preferred_username
            : undefined),
      );

    return {
      ...info,
      ...(profile?.userId ? { id: profile.userId } : {}),
      ...(profile?.username || sessionUser.username
        ? { username: profile?.username ?? sessionUser.username }
        : {}),
      ...(firstName ? { given_name: firstName, firstName } : {}),
      ...(lastName ? { family_name: lastName, lastName } : {}),
      ...(displayName ? { name: displayName, displayName } : {}),
      ...((profile ? profile.picture : info.picture) &&
      typeof (profile ? profile.picture : info.picture) === 'string'
        ? { picture: profile ? profile.picture : info.picture }
        : {}),
    };
  }

  async getUserProfileById(userId: string): Promise<UserProfileItem | null> {
    const profile = await this.usersDocClient.send(
      new GetCommand({
        TableName: this.usersTableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'PROFILE',
        },
      }),
    );

    return (profile.Item as UserProfileItem | undefined) ?? null;
  }

  async updateProfileForUser(
    userId: string,
    input: UpdateProfileInput,
  ): Promise<UserProfileItem> {
    const profile = await this.getUserProfileById(userId);
    if (!profile) {
      throw new BadRequestException('User profile not found');
    }

    const nextUsername =
      input.username !== undefined
        ? this.normalizeUsername(input.username)
        : (profile.username ?? '').toLowerCase();

    if (input.username !== undefined && !nextUsername) {
      throw new BadRequestException(
        'Username must be 3-30 characters: lowercase letters, numbers, underscore',
      );
    }

    const nextFirstName = this.normalizeName(input.firstName, profile.firstName);
    const nextLastName = this.normalizeName(input.lastName, profile.lastName);
    const nextPicture = this.normalizePicture(input.picture, profile.picture);
    const nextDisplayName = this.buildDisplayName(
      nextFirstName,
      nextLastName,
      profile.displayName,
      nextUsername || profile.username || `user${userId.slice(0, 8)}`,
    );
    const now = new Date().toISOString();

    const nextProfile: UserProfileItem = {
      ...profile,
      username: nextUsername || profile.username,
      firstName: nextFirstName,
      lastName: nextLastName,
      displayName: nextDisplayName,
      picture: nextPicture,
      updatedAt: now,
    };

    const currentUsername = (profile.username ?? '').toLowerCase();
    const finalUsername = (nextProfile.username ?? '').toLowerCase();
    const usernameChanged = Boolean(
      finalUsername && finalUsername !== currentUsername,
    );

    if (!usernameChanged) {
      await this.usersDocClient.send(
        new PutCommand({
          TableName: this.usersTableName,
          Item: nextProfile,
          ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
        }),
      );
      return nextProfile;
    }

    try {
      await this.usersDocClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.usersTableName,
                Item: {
                  PK: `USERNAME#${finalUsername}`,
                  SK: 'USER',
                  entity: 'USERNAME',
                  userId,
                  username: finalUsername,
                  createdAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.usersTableName,
                Item: nextProfile,
                ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
              },
            },
            ...(currentUsername
              ? [
                  {
                    Delete: {
                      TableName: this.usersTableName,
                      Key: {
                        PK: `USERNAME#${currentUsername}`,
                        SK: 'USER',
                      },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      const isConditionalConflict =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'TransactionCanceledException';

      if (isConditionalConflict) {
        throw new BadRequestException('Username is already taken');
      }

      throw error;
    }

    return nextProfile;
  }

  mergeProfileIntoSession(
    sessionUser: SessionUser,
    profile: UserProfileItem,
  ): SessionUser {
    const info: Record<string, unknown> = {
      ...(sessionUser.info ?? {}),
      ...(profile.username ? { preferred_username: profile.username } : {}),
      ...(profile.displayName ? { name: profile.displayName } : {}),
    };
    if (profile.firstName) {
      info.given_name = profile.firstName;
    } else {
      delete info.given_name;
    }
    if (profile.lastName) {
      info.family_name = profile.lastName;
    } else {
      delete info.family_name;
    }
    if (profile.picture) {
      info.picture = profile.picture;
    } else {
      delete info.picture;
    }

    return {
      ...sessionUser,
      username: profile.username ?? sessionUser.username,
      info,
    };
  }

  async updateUsernameForUser(
    userId: string,
    nextUsernameRaw: string,
  ): Promise<string> {
    const nextUsername = this.normalizeUsername(nextUsernameRaw);
    if (!nextUsername) {
      throw new BadRequestException(
        'Username must be 3-30 characters: lowercase letters, numbers, underscore',
      );
    }

    const profile = await this.usersDocClient.send(
      new GetCommand({
        TableName: this.usersTableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'PROFILE',
        },
      }),
    );

    if (!profile.Item) {
      throw new BadRequestException('User profile not found');
    }

    const currentUsername = (profile.Item.username as string | undefined)?.toLowerCase();
    if (currentUsername === nextUsername) {
      return nextUsername;
    }

    const now = new Date().toISOString();
    try {
      await this.usersDocClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.usersTableName,
                Item: {
                  PK: `USERNAME#${nextUsername}`,
                  SK: 'USER',
                  entity: 'USERNAME',
                  userId,
                  username: nextUsername,
                  createdAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.usersTableName,
                Item: {
                  ...profile.Item,
                  username: nextUsername,
                  updatedAt: now,
                },
                ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
              },
            },
            ...(currentUsername
              ? [
                  {
                    Delete: {
                      TableName: this.usersTableName,
                      Key: {
                        PK: `USERNAME#${currentUsername}`,
                        SK: 'USER',
                      },
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      const isConditionalConflict =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'TransactionCanceledException';

      if (isConditionalConflict) {
        throw new BadRequestException('Username is already taken');
      }

      throw error;
    }

    return nextUsername;
  }

  private async ensureUserProfile(userInfo: UserinfoResponse): Promise<string> {
    const userId = userInfo.sub as string | undefined;
    if (!userId) {
      throw new Error('OIDC userinfo response does not contain sub');
    }

    const existing = await this.usersDocClient.send(
      new GetCommand({
        TableName: this.usersTableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'PROFILE',
        },
      }),
    );

    if (existing.Item?.username) {
      return existing.Item.username as string;
    }

    const baseUsername = this.buildBaseUsername(userInfo, userId);
    const createdAt = new Date().toISOString();

    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate =
        attempt === 0 ? baseUsername : `${baseUsername}_${attempt + 1}`;

      try {
        await this.usersDocClient.send(
          new PutCommand({
            TableName: this.usersTableName,
            Item: {
              PK: `USERNAME#${candidate}`,
              SK: 'USER',
              entity: 'USERNAME',
              userId,
              username: candidate,
              createdAt,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
      } catch {
        continue;
      }

      const fullName = [userInfo.given_name, userInfo.family_name]
        .filter((part) => typeof part === 'string' && part.trim())
        .join(' ')
        .trim();

      await this.usersDocClient.send(
        new PutCommand({
          TableName: this.usersTableName,
          Item: {
            PK: `USER#${userId}`,
            SK: 'PROFILE',
            entity: 'USER_PROFILE',
            userId,
            username: candidate,
            firstName: userInfo.given_name as string | undefined,
            lastName: userInfo.family_name as string | undefined,
            displayName:
              (userInfo.name as string | undefined) ??
              (fullName || undefined) ??
              (userInfo.preferred_username as string | undefined) ??
              candidate,
            picture: userInfo.picture as string | undefined,
            email: userInfo.email as string | undefined,
            createdAt,
          },
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        }),
      );

      return candidate;
    }

    throw new Error('Could not reserve unique username');
  }

  private buildBaseUsername(userInfo: UserinfoResponse, userId: string): string {
    const preferred = (userInfo.preferred_username as string | undefined)?.trim();
    const email = (userInfo.email as string | undefined)?.trim();
    const fromEmail = email?.split('@')[0];
    const raw = preferred || fromEmail || `user${userId.slice(0, 8)}`;
    const normalized = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const collapsed = normalized.replace(/_+/g, '_').replace(/^_+|_+$/g, '');

    return collapsed || `user${userId.slice(0, 8)}`;
  }

  private normalizeUsername(raw: string): string | null {
    const normalized = raw.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private normalizeName(
    raw: string | null | undefined,
    fallback?: string,
  ): string | undefined {
    if (raw === undefined) {
      return fallback;
    }
    if (raw === null) {
      return undefined;
    }
    const value = raw.trim();
    if (!value) {
      return undefined;
    }
    return value.slice(0, 60);
  }

  private normalizePicture(
    raw: string | null | undefined,
    fallback?: string,
  ): string | undefined {
    if (raw === undefined) {
      return fallback;
    }
    if (raw === null) {
      return undefined;
    }

    const value = raw.trim();
    if (!value) {
      return undefined;
    }

    const isHttp = /^https?:\/\/.+/i.test(value);
    const isDataImage = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(
      value,
    );
    if (!isHttp && !isDataImage) {
      throw new BadRequestException(
        'Picture must be a valid URL or base64 data image',
      );
    }
    if (value.length > 1_500_000) {
      throw new BadRequestException('Picture payload is too large');
    }

    return value;
  }

  private buildDisplayName(
    firstName?: string,
    lastName?: string,
    fallbackName?: string,
    fallbackUsername?: string,
  ): string {
    const fullName = [firstName, lastName]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ')
      .trim();

    return fullName || fallbackName || fallbackUsername || 'User';
  }
}
