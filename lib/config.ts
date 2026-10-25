import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export type EnvName = 'dev' | 'prod';

export interface EnvConfig {
  readonly name: EnvName;
  /** Default region; CDK_DEFAULT_REGION wins when set. */
  readonly region: string;
  readonly vpcCidr: string;
  /** Kept at 2: stacks are account-agnostic, so AZs resolve at deploy time (no context lookups, no AWS calls at synth). */
  readonly maxAzs: number;
  /** 1 = cheapest (single point of failure for egress); equal to maxAzs = AZ-resilient. */
  readonly natGateways: number;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly minTasks: number;
  readonly maxTasks: number;
  /** Tasks that must always run on on-demand Fargate. */
  readonly fargateBase: number;
  /** Relative share of tasks above `fargateBase` placed on on-demand Fargate. */
  readonly fargateWeight: number;
  /** Relative share of tasks above `fargateBase` placed on Fargate Spot. */
  readonly spotWeight: number;
  readonly logRetention: logs.RetentionDays;
  readonly datadogEnabled: boolean;
  readonly datadogSite: string;
  readonly deletionProtection: boolean;
  readonly certificateArn?: string;
  readonly alarmEmail?: string;
}

const BASE: Record<EnvName, EnvConfig> = {
  dev: {
    name: 'dev',
    region: 'us-east-1',
    vpcCidr: '10.10.0.0/16',
    maxAzs: 2,
    natGateways: 1,
    cpu: 256,
    memoryMiB: 512,
    minTasks: 1,
    maxTasks: 3,
    fargateBase: 0,
    fargateWeight: 0,
    spotWeight: 1, // dev is 100% Spot: cheap, interruptions are acceptable
    logRetention: logs.RetentionDays.ONE_WEEK,
    datadogEnabled: false,
    datadogSite: 'datadoghq.com',
    deletionProtection: false,
  },
  prod: {
    name: 'prod',
    region: 'us-east-1',
    vpcCidr: '10.20.0.0/16',
    maxAzs: 2,
    natGateways: 2, // one per AZ: losing an AZ must not cut egress for the other
    cpu: 512,
    memoryMiB: 1024,
    minTasks: 2,
    maxTasks: 10,
    fargateBase: 2, // the floor is always on-demand; Spot only absorbs burst
    fargateWeight: 1,
    spotWeight: 1,
    logRetention: logs.RetentionDays.ONE_MONTH,
    datadogEnabled: true,
    datadogSite: 'datadoghq.com',
    deletionProtection: true,
  },
};

/**
 * Environment defaults plus optional CDK context overrides, e.g.
 *   cdk deploy --all -c env=prod -c certificateArn=arn:aws:acm:... -c alarmEmail=oncall@example.com
 */
export function loadConfig(app: cdk.App, envName?: string): EnvConfig {
  const name = (envName ?? app.node.tryGetContext('env') ?? 'dev') as EnvName;
  if (!(name in BASE)) {
    throw new Error(`Unknown env "${name}". Use -c env=dev or -c env=prod.`);
  }
  const base = BASE[name];
  const datadog = app.node.tryGetContext('datadog');
  return {
    ...base,
    certificateArn: app.node.tryGetContext('certificateArn') ?? base.certificateArn,
    alarmEmail: app.node.tryGetContext('alarmEmail') ?? base.alarmEmail,
    datadogSite: app.node.tryGetContext('datadogSite') ?? base.datadogSite,
    datadogEnabled: datadog === undefined ? base.datadogEnabled : String(datadog) === 'true',
  };
}

export const prefixFor = (config: EnvConfig): string => `ecs-platform-${config.name}`;
