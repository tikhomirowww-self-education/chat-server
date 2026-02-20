import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";

export class ChatServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const requiredEnv = (name: string): string => {
      const value = process.env[name];
      if (!value) {
        throw new Error(`Missing required env for CDK deploy: ${name}`);
      }
      return value;
    };

    const parameterPrefix = process.env.PARAMETER_PREFIX ?? "/chatapp";
    const appDomain = ssm.StringParameter.valueForStringParameter(
      this,
      `${parameterPrefix}/shared/app-domain`
    );

    const albCertificateArn =
      process.env.ALB_CERTIFICATE_ARN ??
      ssm.StringParameter.valueForStringParameter(
        this,
        `${parameterPrefix}/shared/alb-certificate-arn`
      );

    const awsRegion =
      process.env.AWS_REGION ||
      process.env.DYNAMODB_REGION ||
      this.region ||
      process.env.CDK_DEFAULT_REGION ||
      "eu-central-1";

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const repo = ecr.Repository.fromRepositoryName(this, "Repo", "chat-backend");
    const imageTag = requiredEnv("IMAGE_TAG");
    const imageUri = repo.repositoryUriForTag(imageTag);

    const containerEnv: Record<string, string> = {
      NODE_ENV: "production",
      PORT: "3000",
      AWS_REGION: awsRegion,
      COGNITO_ISSUER_URL: requiredEnv("COGNITO_ISSUER_URL"),
      COGNITO_CLIENT_ID: requiredEnv("COGNITO_CLIENT_ID"),
      COGNITO_CLIENT_SECRET: requiredEnv("COGNITO_CLIENT_SECRET"),
      COGNITO_REDIRECT_URI:
        process.env.COGNITO_REDIRECT_URI ?? `https://${appDomain}/api/auth/callback`,
      POST_LOGOUT_REDIRECT: process.env.POST_LOGOUT_REDIRECT ?? `https://${appDomain}`,
      COGNITO_SCOPE: process.env.COGNITO_SCOPE ?? "openid",
      CORS_ORIGIN: process.env.CORS_ORIGIN ?? `https://${appDomain}`,
      SESSION_SECRET: requiredEnv("SESSION_SECRET"),
      DYNAMODB_REGION: requiredEnv("DYNAMODB_REGION"),
      DYNAMODB_TABLE: requiredEnv("DYNAMODB_TABLE"),
      DYNAMODB_USER_ROOMS_GSI: process.env.DYNAMODB_USER_ROOMS_GSI ?? "GSI1",
      ...(process.env.DYNAMODB_ENDPOINT
        ? { DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT }
        : {}),
      ...(process.env.AWS_ACCESS_KEY_ID
        ? { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID }
        : {}),
      ...(process.env.AWS_SECRET_ACCESS_KEY
        ? { AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY }
        : {}),
      ...(process.env.AWS_SESSION_TOKEN
        ? { AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN }
        : {}),
    };

    const envFileContent = Object.entries(containerEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const instanceRole = new iam.Role(this, "ApiInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonEC2ContainerRegistryReadOnly"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });
    repo.grantPull(instanceRole);

    const apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Allow app traffic from ALB to chat backend",
    });

    const keyName = process.env.EC2_KEY_NAME;
    const instance = new ec2.Instance(this, "ApiInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: apiSecurityGroup,
      role: instanceRole,
      userDataCausesReplacement: true,
      instanceType: new ec2.InstanceType(
        process.env.EC2_INSTANCE_TYPE ?? "t3.micro"
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(16, { encrypted: true }),
        },
      ],
      ...(keyName ? { keyName } : {}),
    });

    const accountId = cdk.Stack.of(this).account;
    instance.userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y docker",
      "systemctl enable docker",
      "systemctl start docker",
      "mkdir -p /opt/chat-backend",
      "cat > /opt/chat-backend/.env <<'EOF'",
      envFileContent,
      "EOF",
      `aws ecr get-login-password --region ${awsRegion} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${awsRegion}.amazonaws.com`,
      `docker pull ${imageUri}`,
      "docker rm -f chat-backend || true",
      `docker run -d --name chat-backend --restart unless-stopped --env-file /opt/chat-backend/.env -p 3000:3000 ${imageUri}`
    );

    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Public ALB security group",
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Public HTTP"
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Public HTTPS"
    );
    apiSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      "App traffic from ALB"
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, "ApiAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "ApiAlbCertificate",
      albCertificateArn
    );

    const redirectHttpToHttps =
      (process.env.ALB_REDIRECT_HTTP_TO_HTTPS ?? "false").toLowerCase() === "true";

    const targetProps: elbv2.AddApplicationTargetsProps = {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2Targets.InstanceTarget(instance, 3000)],
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200-399",
      },
    };

    const httpsListener = alb.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      open: true,
    });
    httpsListener.addTargets("ApiTargetHttps", targetProps);

    const httpListener = alb.addListener("HttpRedirectListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });
    if (redirectHttpToHttps) {
      httpListener.addAction("HttpRedirectToHttpsAction", {
        action: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      httpListener.addTargets("ApiTargetHttp", targetProps);
    }

    const apiAlbDnsParameter = new ssm.StringParameter(this, "ApiAlbDnsParameter", {
      parameterName: `${parameterPrefix}/server/api-alb-dns`,
      stringValue: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: `https://${appDomain}/api`,
    });

    new cdk.CfnOutput(this, "ApiAlbDnsName", {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, "ApiAlbDnsParameterName", {
      value: apiAlbDnsParameter.parameterName,
    });

    new cdk.CfnOutput(this, "ApiSsmInstanceId", {
      value: instance.instanceId,
    });
  }
}
