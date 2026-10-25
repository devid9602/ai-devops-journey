#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { createPlatform } from '../lib/platform';

const app = new cdk.App();
const config = loadConfig(app);

// Deliberately account-agnostic (region only): no AWS context lookups at synth time, so `cdk synth`
// works in CI and on laptops without credentials, and the same code deploys to any account.
const env: cdk.Environment = { region: process.env.CDK_DEFAULT_REGION ?? config.region };

createPlatform(app, config, env);

// One-time bootstrap of keyless CI/CD:  cdk deploy ecs-platform-github-oidc -c githubRepo=owner/name
const githubRepo = app.node.tryGetContext('githubRepo');
if (githubRepo) {
  new GithubOidcStack(app, 'ecs-platform-github-oidc', {
    env,
    repo: githubRepo,
    environments: ['dev', 'prod'],
    existingProviderArn: app.node.tryGetContext('existingOidcProviderArn'),
  });
}

cdk.Tags.of(app).add('project', 'ecs-fargate-platform');
cdk.Tags.of(app).add('environment', config.name);
cdk.Tags.of(app).add('managed-by', 'cdk');
