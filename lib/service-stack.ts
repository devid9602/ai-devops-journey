import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { EnvConfig } from './config';

export interface ServiceStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly logGroup: logs.ILogGroup;
}

const CONTAINER_PORT = 8080;

export class ServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);
    const { config, vpc, cluster, logGroup } = props;
    const isProd = config.deletionProtection;

    // ---- Task definition -------------------------------------------------
    // ARM64 (Graviton) Fargate is ~20% cheaper per vCPU/GB-hour than x86.
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDefinition.addContainer('app', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', 'app'), {
        platform: ecr_assets.Platform.LINUX_ARM64,
      }),
      portMappings: [{ containerPort: CONTAINER_PORT }],
      readonlyRootFilesystem: true,
      // Must exceed the app's graceful-shutdown window (25s) so SIGKILL never cuts in-flight requests.
      stopTimeout: cdk.Duration.seconds(30),
      // tini as PID 1 so signals are forwarded and zombies are reaped.
      linuxParameters: new ecs.LinuxParameters(this, 'LinuxParams', { initProcessEnabled: true }),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
      environment: {
        APP_ENV: config.name,
        PORT: String(CONTAINER_PORT),
        // Keep V8's heap below the container limit so Node throws/GCs before the kernel OOM-kills the task
        // (an OOM-killed task surfaces to users as 502/504 from the ALB). 75% leaves room for buffers and native memory.
        NODE_OPTIONS: `--max-old-space-size=${Math.floor(config.memoryMiB * 0.75)}`,
      },
      healthCheck: {
        command: ['CMD-SHELL', `wget -qO- http://127.0.0.1:${CONTAINER_PORT}/healthz >/dev/null || exit 1`],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    // ---- Service: Spot/on-demand mix, safe deployments -------------------
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: config.minTasks,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(30),
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE', base: config.fargateBase, weight: config.fargateWeight },
        { capacityProvider: 'FARGATE_SPOT', weight: config.spotWeight },
      ],
    });

    // ---- ALB -------------------------------------------------------------
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      deletionProtection: config.deletionProtection,
      dropInvalidHeaderFields: true,
      idleTimeout: cdk.Duration.seconds(60),
    });

    const accessLogBucket = new s3.Bucket(this, 'AlbAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED, // ALB log delivery supports SSE-S3 only
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(isProd ? 90 : 14) }],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
    this.loadBalancer.logAccessLogs(accessLogBucket);

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: CONTAINER_PORT,
      targets: [this.service],
      // Matches the app's 25s drain; the default of 300s makes every deploy needlessly slow.
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/healthz',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    if (config.certificateArn) {
      this.loadBalancer.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(config.certificateArn)],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [targetGroup],
      });
      this.loadBalancer.addListener('HttpRedirect', {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      // Demo mode: HTTP only. Pass -c certificateArn=... to get HTTPS + redirect.
      this.loadBalancer.addListener('Http', { port: 80, defaultTargetGroups: [targetGroup] });
    }

    // ---- Autoscaling -----------------------------------------------------
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.minTasks,
      maxCapacity: config.maxTasks,
    });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.minutes(5),
    });
    scaling.scaleOnMemoryUtilization('Memory', {
      targetUtilizationPercent: 75,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.minutes(5),
    });
    scaling.scaleOnRequestCount('Requests', {
      requestsPerTarget: 1000, // per target per minute
      targetGroup,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.minutes(5),
    });

    // ---- Alarms ----------------------------------------------------------
    const alarmTopic = new sns.Topic(this, 'AlarmTopic');
    if (config.alarmEmail) {
      alarmTopic.addSubscription(new subs.EmailSubscription(config.alarmEmail));
    }
    const minute = cdk.Duration.minutes(1);
    const alarms: cloudwatch.Alarm[] = [
      new cloudwatch.Alarm(this, 'Elb5xx', {
        alarmDescription: 'ALB itself is returning 5xx (502/503/504): see docs/runbooks/502-504-troubleshooting.md',
        metric: this.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
          period: minute,
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'Target5xx', {
        alarmDescription: 'Application targets are returning 5xx',
        metric: targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: minute,
          statistic: 'Sum',
        }),
        threshold: 10,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'UnhealthyHosts', {
        alarmDescription: 'One or more targets are failing ALB health checks',
        metric: targetGroup.metrics.unhealthyHostCount({ period: minute, statistic: 'Maximum' }),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'MemoryHigh', {
        alarmDescription: 'Memory above 85%: OOM kills (seen by users as 502/504) are close',
        metric: this.service.metricMemoryUtilization({ period: minute }),
        threshold: 85,
        evaluationPeriods: 5,
        datapointsToAlarm: 4,
      }),
      new cloudwatch.Alarm(this, 'CpuHigh', {
        alarmDescription: 'CPU above 85% for 5 minutes: autoscaling is not keeping up or max capacity is reached',
        metric: this.service.metricCpuUtilization({ period: minute }),
        threshold: 85,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
      }),
    ];
    alarms.forEach((alarm) => alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic)));

    // ---- Outputs ---------------------------------------------------------
    const scheme = config.certificateArn ? 'https' : 'http';
    new cdk.CfnOutput(this, 'ServiceUrl', { value: `${scheme}://${this.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
