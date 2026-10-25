import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** "owner/name" of the GitHub repository allowed to deploy. */
  readonly repo: string;
  /** GitHub Environments allowed to assume the role (maps to the OIDC `sub` claim). */
  readonly environments: string[];
  /** Reuse the account's existing GitHub OIDC provider (only one can exist per account). */
  readonly existingProviderArn?: string;
  /** CDK bootstrap qualifier; default matches `cdk bootstrap` defaults. */
  readonly bootstrapQualifier?: string;
}

/**
 * Keyless CI/CD: GitHub Actions exchanges its OIDC token for short-lived AWS credentials.
 * The role can do exactly one thing: assume the CDK bootstrap roles. All real permissions live in those
 * (and in the CloudFormation execution role), and only the named GitHub Environments can assume it.
 */
export class GithubOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    const qualifier = props.bootstrapQualifier ?? 'hnb659fds';

    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubProvider', props.existingProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'ecs-platform-github-deploy',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': props.environments.map(
            (env) => `repo:${props.repo}:environment:${env}`,
          ),
        },
      }),
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-${qualifier}-*-role-${this.account}-*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Set this as the AWS_DEPLOY_ROLE_ARN repository variable',
    });
  }
}
