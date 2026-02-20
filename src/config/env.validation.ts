import Joi from 'joi';

export const envValidationSchema = Joi.object({
  COGNITO_ISSUER_URL: Joi.string().uri().required(),
  COGNITO_CLIENT_ID: Joi.string().min(1).required(),
  COGNITO_CLIENT_SECRET: Joi.string().min(1).required(),
  COGNITO_REDIRECT_URI: Joi.string().uri().required(),
  POST_LOGOUT_REDIRECT: Joi.string().uri().required(),
  COGNITO_SCOPE: Joi.string().default('openid'),
  SESSION_SECRET: Joi.string().min(16).required(),
  DYNAMODB_REGION: Joi.string().min(1).required(),
  DYNAMODB_TABLE: Joi.string().min(3).required(),
  DYNAMODB_USER_ROOMS_GSI: Joi.string().min(3).default('GSI1'),
  DYNAMODB_ENDPOINT: Joi.string().uri().optional(),
  AWS_ACCESS_KEY_ID: Joi.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().min(1).optional(),
  AWS_SESSION_TOKEN: Joi.string().allow('').optional(),
}).with('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')
  .with('AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID');
