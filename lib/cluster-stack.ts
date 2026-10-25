import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import { EnvConfig, prefixFor } from './config';

export interface ClusterStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
}

export class ClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: prefixFor(config),
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      // Registers the FARGATE and FARGATE_SPOT capacity providers so services can mix them.
      enableFargateCapacityProviders: true,
    });
  }
}
