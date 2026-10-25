import * as cdk from 'aws-cdk-lib';
import { ClusterStack } from './cluster-stack';
import { EnvConfig, prefixFor } from './config';
import { LoggingStack } from './logging-stack';
import { NetworkStack } from './network-stack';
import { ServiceStack } from './service-stack';

export interface Platform {
  readonly network: NetworkStack;
  readonly cluster: ClusterStack;
  readonly logging: LoggingStack;
  readonly service: ServiceStack;
}

/** Wires the four stacks of one environment. Shared by bin/app.ts and the tests. */
export function createPlatform(app: cdk.App, config: EnvConfig, env: cdk.Environment): Platform {
  const prefix = prefixFor(config);

  const network = new NetworkStack(app, `${prefix}-network`, { env, config });
  const cluster = new ClusterStack(app, `${prefix}-cluster`, { env, config, vpc: network.vpc });
  const logging = new LoggingStack(app, `${prefix}-logging`, { env, config });
  const service = new ServiceStack(app, `${prefix}-service`, {
    env,
    config,
    vpc: network.vpc,
    cluster: cluster.cluster,
    logGroup: logging.logGroup,
  });

  return { network, cluster, logging, service };
}
