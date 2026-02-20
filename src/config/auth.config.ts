import { registerAs } from '@nestjs/config';

export default registerAs('auth', () => ({
  cognitoIssuerUrl: process.env.COGNITO_ISSUER_URL as string,
  clientId: process.env.COGNITO_CLIENT_ID as string,
  clientSecret: process.env.COGNITO_CLIENT_SECRET as string,
  redirectUri: process.env.COGNITO_REDIRECT_URI as string,
  postLogoutRedirectUri: process.env.POST_LOGOUT_REDIRECT as string,
  scope: process.env.COGNITO_SCOPE ?? 'openid',
}));
