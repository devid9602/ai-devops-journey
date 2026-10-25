# Cost model

Numbers are **approximate us-east-1 on-demand list prices** at the time of writing. Verify with the AWS Pricing Calculator before relying on them; Spot prices vary by AZ and over time.

| Component | Price used |
|---|---|
| Fargate ARM64 | $0.03238 / vCPU-hour, $0.00356 / GB-hour |
| Fargate x86 (for comparison) | $0.04048 / vCPU-hour, $0.004445 / GB-hour |
| NAT gateway | $0.045 / hour + $0.045 / GB processed |
| ALB | $0.0225 / hour + LCU usage |

## Monthly baseline (730 h, minimum task count, ignoring data transfer and LCUs)

| | dev | prod |
|---|---|---|
| Task size | 0.25 vCPU / 0.5 GB | 0.5 vCPU / 1 GB |
| Tasks (minimum) | 1 | 2 |
| Fargate compute | ~$7 (before Spot discount) | ~$29 |
| NAT gateways | 1 = ~$33 | 2 = ~$66 |
| ALB | ~$16 | ~$16 |
| **Baseline** | **~$56** | **~$111** |

## What this tells you

1. **NAT gateways cost more than the compute.** In dev, NAT is ~60% of the bill. That is why NAT count is a per-environment setting (`natGateways` in `lib/config.ts`) and why the S3 gateway endpoint (free) is always on, so ECR layer pulls skip the NAT.
2. **Graviton** saves ~20% on Fargate versus x86 for no code change (the image is built for `linux/arm64`).
3. **Spot** is ~70% cheaper than on-demand for the tasks it covers. Prod keeps `fargateBase` tasks on-demand and only lets burst capacity land on Spot; dev is 100% Spot.
4. **Right-sizing beats everything else at scale.** Alarms for CPU/memory above 85% and target-tracking at 60%/75% exist so the task size can be reduced until utilization sits near target, rather than over-provisioning "to be safe".

## Levers not enabled (and why)

- **Interface VPC endpoints for ECR/CloudWatch Logs:** each costs ~$0.01/h per AZ plus data. They only beat NAT once traffic through NAT is high enough. Worth it above roughly a few hundred GB/month of image pulls and logs; not at demo scale.
- **Savings Plans (Compute):** commit only after a few weeks of stable baseline usage.
- **Scheduled scale-to-zero for dev:** an easy next step (Application Auto Scaling scheduled actions at night and weekends).
