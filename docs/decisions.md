# Architecture decisions

Short records of the non-obvious choices.

## 1. CDK in TypeScript, four stacks per environment
Stacks follow change frequency and blast radius: **network** (rarely changes) -> **cluster** -> **logging** -> **service** (changes every deploy). A service deploy can never touch the VPC. Trade-off: cross-stack references create export dependencies, so the network stack can't be deleted while others use it. That's the desired safety property.

## 2. Stacks are account-agnostic (region only)
No `env.account` means no context lookups: `cdk synth` and the tests run anywhere with zero AWS credentials, and the same code deploys to any account. Trade-off: AZs are resolved by CloudFormation at deploy time, limiting a VPC to 2 AZs in CDK. That is a deliberate cap, not an accident (documented in `config.ts`).

## 3. CloudWatch Logs -> Firehose -> Datadog (instead of FireLens or the Datadog Forwarder Lambda)
- CloudWatch stays the source of truth with short retention, so an outage of the log vendor never loses logs, and Logs Insights works during a Datadog incident.
- Firehose is managed, buffers, retries, and writes failed batches to S3 instead of dropping them. No Lambda to patch or scale.
- FireLens/Fluent Bit sidecars add per-task CPU/memory and another image to maintain. They're the better choice if you need per-line enrichment or to bypass CloudWatch ingestion cost entirely.
- Trade-off: you pay CloudWatch ingestion ($0.50/GB) *and* Firehose ingestion. At high volume, move to FireLens with a direct Datadog output.

## 4. Fargate Spot mix with an on-demand floor
Prod keeps `fargateBase` tasks on-demand (so a Spot reclaim wave never takes the service below its floor) and splits burst capacity between Spot and on-demand. Spot tasks get a 2-minute warning; the app's SIGTERM handler drains inside that window.

## 5. Keyless deploys via GitHub OIDC, scoped by GitHub Environment
No AWS access keys exist anywhere. The trust policy matches the OIDC `sub` claim `repo:<owner>/<repo>:environment:<env>`, so only jobs running in the `dev` or `prod` Environment can assume the role (and prod requires a human approval). The role itself can only assume the CDK bootstrap roles; those hold the real permissions.

## 6. Defaults that prevent 502/504s
- Node `keepAliveTimeout` (65 s) > ALB idle timeout (60 s): avoids the classic race where Node closes a connection the ALB is about to reuse.
- ECS `stopTimeout` (30 s) > app drain (25 s) and target group `deregistrationDelay` (30 s): in-flight requests finish before SIGKILL.
- V8 `--max-old-space-size` at 75% of container memory: the process fails or GCs before the kernel OOM-kills the task.
- Deployment circuit breaker with rollback, `minHealthyPercent: 100`: a bad image never replaces healthy tasks.
See [the runbook](runbooks/502-504-troubleshooting.md).
