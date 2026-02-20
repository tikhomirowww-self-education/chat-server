#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import "dotenv/config";
import { ChatServerStack } from "../lib/server-stack";

const app = new cdk.App();
new ChatServerStack(app, "ChatServerStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
  },
});
