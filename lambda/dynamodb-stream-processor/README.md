# DynamoDB Stream Processor Lambda

This Lambda is for asynchronous side effects only.

- Core CRUD stays in Nest (`RoomsService` + DynamoDB)
- Lambda reacts to table stream events (`INSERT/MODIFY/REMOVE`)

## Package

```bash
cd server/lambda/dynamodb-stream-processor
zip -r function.zip index.mjs
```

## Upload zip to S3

```bash
aws s3 cp function.zip s3://<your-bucket>/chat-lambda/function.zip
```

## Deploy CloudFormation stack

Use template: `server/infrastructure/dynamodb-stream-lambda.yaml`

```bash
aws cloudformation deploy \
  --template-file server/infrastructure/dynamodb-stream-lambda.yaml \
  --stack-name chat-ddb-stream-processor \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    TableName=chat_app_table \
    LambdaFunctionName=chat-dynamodb-stream-processor \
    LambdaCodeS3Bucket=<your-bucket> \
    LambdaCodeS3Key=chat-lambda/function.zip
```

After deploy, check CloudWatch Logs for `chat.message.created` and
`chat.membership.created` events.
