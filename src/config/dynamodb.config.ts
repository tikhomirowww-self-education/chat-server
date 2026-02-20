import { registerAs } from '@nestjs/config';

export default registerAs('dynamodb', () => ({
  region: process.env.DYNAMODB_REGION as string,
  tableName: process.env.DYNAMODB_TABLE as string,
  userRoomsIndex: process.env.DYNAMODB_USER_ROOMS_GSI as string,
  endpoint: process.env.DYNAMODB_ENDPOINT,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
}));
