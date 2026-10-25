import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
}

/**
 * Two-tier VPC: public subnets (ALB, NAT) and private subnets (tasks).
 * NAT is the dominant fixed cost of this platform, so NAT count is a per-env knob (see docs/cost.md).
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      retention: config.logRetention,
      removalPolicy: config.deletionProtection ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: config.maxAzs,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      // Free, and keeps S3 (ECR image layers live there) traffic off the NAT.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
      // REJECT-only keeps flow-log volume (and cost) low while still useful for debugging SG/NACL issues.
      flowLogs: {
        rejected: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.REJECT,
        },
      },
    });
  }
}
