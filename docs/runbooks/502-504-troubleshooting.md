# Runbook: ALB 502 / 503 / 504

Alarm: `Elb5xx` (ALB-generated 5xx) or `Target5xx`. Goal: find which of the cases below you are in within ~10 minutes.

## 1. Triage: who generated the error?

| Signal | Meaning |
|---|---|
| `HTTPCode_ELB_502_Count` up | Target closed the connection, sent a malformed response, or no healthy-and-reachable target |
| `HTTPCode_ELB_503_Count` up | No registered healthy targets at all |
| `HTTPCode_ELB_504_Count` up | Target didn't answer within the idle timeout (60 s) |
| `HTTPCode_Target_5XX_Count` up | The application itself returned 5xx (not an ALB problem) |

Check **UnHealthyHostCount**, **RunningTaskCount** vs desired, and the ECS service **Events** tab first.

## 2. Common causes, in the order to check them

1. **Tasks are being killed (OOM).** Memory alarm `MemoryHigh` fired earlier? In ECS -> Tasks (stopped), look for `OutOfMemoryError: Container killed due to memory usage` or exit code 137. Users see 502/504 while the replacement task starts.
   - Fix: raise `memoryMiB` in `lib/config.ts`; investigate leaks; confirm `NODE_OPTIONS=--max-old-space-size` is ~75% of the limit so Node throws or GCs before the kernel kills it.
2. **Keep-alive race.** Sporadic single 502s under steady traffic with healthy targets. Confirm the app's `keepAliveTimeout` exceeds the ALB idle timeout (60 s). This repo sets 65 s.
3. **Deployment in progress / bad release.** Service events show a rollout; the circuit breaker may have rolled back. Compare the failing task definition revision with the previous one.
4. **Health checks failing.** Target group -> Targets shows `unhealthy` with a reason code (`Request timed out`, `Response code mismatch`). Check the `/healthz` path and security-group rules ALB -> task port 8080.
5. **Slow dependency -> 504.** Latency percentile up and CPU low: the app is waiting on something downstream. Look at traces and request durations in the app logs (`duration_ms`).
6. **Spot reclaim.** Service events show `stopped (Your Spot Task was interrupted)`. Expected occasionally; if it causes user impact, raise `fargateBase`.

## 3. Useful queries (CloudWatch Logs Insights, log group `/ecs/ecs-platform-<env>/app`)

```
fields @timestamp, msg, path, status, duration_ms
| filter status >= 500 or level = "error"
| sort @timestamp desc
| limit 100
```

```
stats count() as requests, pct(duration_ms, 95) as p95, pct(duration_ms, 99) as p99 by bin(1m)
```

ALB access logs (S3, Athena) contain `elb_status_code`, `target_status_code`, and `target_processing_time`. `elb_status_code=502` with `target_status_code=-` means the target never sent a response.

## 4. Mitigation

- Scale out now: `aws ecs update-service --cluster ecs-platform-<env> --service <name> --desired-count <n>`. Application Auto Scaling may later reduce it again.
- Bad release: redeploy the previous commit (the Deploy workflow is idempotent).
- Always capture the stopped-task reason and the timeline before changing anything; write the post-incident note while it's fresh.
