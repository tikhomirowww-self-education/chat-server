# Server Infra

Deploys backend runtime only:

- VPC
- EC2 instance (Docker pull from ECR)
- ALB
- Health checks
- SSM output with ALB DNS name for client infra

## Prerequisites

1. `infra/ChatSharedConfigStack` is deployed.
2. Backend Docker image is pushed to ECR `chat-backend`.

## Deploy

```bash
cd server/infra
npm install

IMAGE_TAG=prod-amd64-v2 \
COGNITO_ISSUER_URL=https://cognito-idp.eu-central-1.amazonaws.com/xxxx \
COGNITO_CLIENT_ID=... \
COGNITO_CLIENT_SECRET=... \
SESSION_SECRET=... \
DYNAMODB_REGION=eu-central-1 \
DYNAMODB_TABLE=chat-rooms \
npx cdk deploy ChatServerStack
```

Optional:

- `PARAMETER_PREFIX` (default: `/chatapp`)
- `COGNITO_REDIRECT_URI` (default from shared domain: `https://<domain>/api/auth/callback`)
- `POST_LOGOUT_REDIRECT` (default from shared domain)
- `CORS_ORIGIN` (default from shared domain)
- `ALB_REDIRECT_HTTP_TO_HTTPS` (default: `false`)
