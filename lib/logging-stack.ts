import * as cdk from 'aws-cdk-lib';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, prefixFor } from './config';

export interface LoggingStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
}

/**
 * Application logs: container stdout -> CloudWatch Logs -> subscription filter -> Kinesis Data Firehose -> Datadog.
 *
 * CloudWatch stays the system of record (short retention, queryable with Logs Insights) and Datadog gets a
 * near-real-time copy. Firehose failures land in an S3 bucket instead of being dropped.
 *
 * Prerequisite when datadogEnabled: a Secrets Manager secret named `ecs-platform/<env>/datadog-api-key`
 * whose SecretString is the plain Datadog API key.
 */
export class LoggingStack extends cdk.Stack {
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: LoggingStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = prefixFor(config);
    const isProd = config.deletionProtection;

    this.logGroup = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: `/ecs/${prefix}/app`,
      retention: config.logRetention,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    if (!config.datadogEnabled) {
      return;
    }

    const apiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'DatadogApiKey',
      `ecs-platform/${config.name}/datadog-api-key`,
    );

    const failedDataBucket = new s3.Bucket(this, 'FirehoseFailedData', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    const deliveryLogGroup = new logs.LogGroup(this, 'FirehoseDeliveryLogs', {
      logGroupName: `/aws/firehose/${prefix}-datadog`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    failedDataBucket.grantReadWrite(firehoseRole);
    deliveryLogGroup.grantWrite(firehoseRole);

    const stream = new firehose.CfnDeliveryStream(this, 'DatadogStream', {
      deliveryStreamName: `${prefix}-datadog`,
      deliveryStreamType: 'DirectPut',
      httpEndpointDestinationConfiguration: {
        endpointConfiguration: {
          name: 'Datadog',
          url: `https://aws-kinesis-http-intake.logs.${config.datadogSite}/v1/input`,
          // Rendered as a CloudFormation dynamic reference ({{resolve:secretsmanager:...}}); the key never appears in the template.
          accessKey: apiKeySecret.secretValue.unsafeUnwrap(),
        },
        requestConfiguration: {
          contentEncoding: 'GZIP',
          commonAttributes: [
            { attributeName: 'env', attributeValue: config.name },
            { attributeName: 'service', attributeValue: 'sample-api' },
          ],
        },
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 4 },
        retryOptions: { durationInSeconds: 60 },
        s3BackupMode: 'FailedDataOnly',
        s3Configuration: {
          bucketArn: failedDataBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'GZIP',
          prefix: 'failed/',
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: deliveryLogGroup.logGroupName,
          logStreamName: 'delivery',
        },
        roleArn: firehoseRole.roleArn,
      },
    });
    stream.node.addDependency(firehoseRole);

    // CloudWatch Logs needs its own role to put records into the stream.
    const subscriptionRole = new iam.Role(this, 'LogsToFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('logs.amazonaws.com'),
    });
    subscriptionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [stream.attrArn],
      }),
    );

    const subscription = new logs.CfnSubscriptionFilter(this, 'AppLogsToDatadog', {
      logGroupName: this.logGroup.logGroupName,
      destinationArn: stream.attrArn,
      roleArn: subscriptionRole.roleArn,
      filterPattern: '',
    });
    subscription.node.addDependency(subscriptionRole);
  }
}
