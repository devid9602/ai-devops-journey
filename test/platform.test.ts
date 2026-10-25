import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { EnvName, loadConfig } from '../lib/config';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { createPlatform } from '../lib/platform';

const env = { region: 'us-east-1' };

function build(name: EnvName, context: Record<string, unknown> = {}) {
  const app = new cdk.App({ context: { env: name, ...context } });
  const platform = createPlatform(app, loadConfig(app), env);
  return {
    network: Template.fromStack(platform.network),
    logging: Template.fromStack(platform.logging),
    service: Template.fromStack(platform.service),
  };
}

describe('network', () => {
  test('prod has a NAT gateway per AZ, dev has one', () => {
    build('prod').network.resourceCountIs('AWS::EC2::NatGateway', 2);
    build('dev').network.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('S3 gateway endpoint and REJECT flow logs exist', () => {
    const { network } = build('prod');
    network.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    network.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
  });
});

describe('service', () => {
  test('uses Graviton, a read-only root filesystem and a stop timeout longer than the app drain', () => {
    build('prod').service.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ ReadonlyRootFilesystem: true, StopTimeout: 30 }),
      ]),
    });
  });

  test('V8 heap is capped below the container memory limit', () => {
    build('prod').service.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: 'NODE_OPTIONS', Value: '--max-old-space-size=768' }]),
        }),
      ]),
    });
  });

  test('deployments are zero-downtime with automatic rollback', () => {
    build('prod').service.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      }),
    });
  });

  test('prod keeps an on-demand floor and mixes in Spot; dev is all Spot', () => {
    build('prod').service.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: Match.arrayWith([
        Match.objectLike({ CapacityProvider: 'FARGATE', Base: 2, Weight: 1 }),
        Match.objectLike({ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }),
      ]),
    });
    build('dev').service.hasResourceProperties('AWS::ECS::Service', {
      CapacityProviderStrategy: Match.arrayWith([
        Match.objectLike({ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }),
      ]),
    });
  });

  test('tasks are never publicly reachable', () => {
    const { service } = build('prod');
    service.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
    });
    const serviceSgs = Object.entries(service.findResources('AWS::EC2::SecurityGroup')).filter(([id]) =>
      id.startsWith('ServiceSecurityGroup'),
    );
    expect(serviceSgs.length).toBeGreaterThan(0);
    for (const [, sg] of serviceSgs) {
      expect(JSON.stringify(sg.Properties.SecurityGroupIngress ?? [])).not.toContain('0.0.0.0/0');
    }
  });

  test('prod ALB has deletion protection and access logging', () => {
    const { service } = build('prod');
    service.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      ]),
    });
  });

  test('HTTP redirects to HTTPS when a certificate is supplied', () => {
    const { service } = build('prod', { certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/abc' });
    service.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS' });
    service.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect' })],
    });
  });

  test('autoscaling policies and alarms are configured', () => {
    const { service } = build('prod');
    service.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 2, MaxCapacity: 10 });
    service.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 3);
    service.resourceCountIs('AWS::CloudWatch::Alarm', 5);
  });
});

describe('logging', () => {
  test('prod ships logs to Datadog via Firehose without embedding the API key', () => {
    const { logging } = build('prod');
    logging.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
    logging.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      HttpEndpointDestinationConfiguration: Match.objectLike({
        S3BackupMode: 'FailedDataOnly',
        RequestConfiguration: Match.objectLike({ ContentEncoding: 'GZIP' }),
      }),
    });
    logging.resourceCountIs('AWS::Logs::SubscriptionFilter', 1);
    expect(JSON.stringify(logging.toJSON())).toContain('resolve:secretsmanager');
  });

  test('dev skips the Datadog pipeline by default but can opt in', () => {
    build('dev').logging.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 0);
    build('dev', { datadog: 'true' }).logging.resourceCountIs('AWS::KinesisFirehose::DeliveryStream', 1);
  });
});

describe('github oidc', () => {
  test('trust is limited to the named repo and environments, and the role can only assume CDK roles', () => {
    const app = new cdk.App();
    const stack = new GithubOidcStack(app, 'oidc', { env, repo: 'me/repo', environments: ['dev', 'prod'] });
    const template = Template.fromStack(stack);
    const trust = JSON.stringify(template.findResources('AWS::IAM::Role'));
    expect(trust).toContain('repo:me/repo:environment:dev');
    expect(trust).toContain('repo:me/repo:environment:prod');
    expect(trust).not.toContain('repo:me/repo:*');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [Match.objectLike({ Action: 'sts:AssumeRole' })],
      },
    });
  });
});
