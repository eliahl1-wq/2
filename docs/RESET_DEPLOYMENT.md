# Production deployments at arena reset

Railway service `2` follows `eliahl1-wq/2`, branch `main`, without a pinned
commit. GitHub Actions queues each main commit using
`.github/workflows/queue-production-release.yml`.

Railway's watch pattern is `__arena_reset_deploy_only__/**`, an intentionally
unused path. Ordinary source pushes therefore create skipped Railway builds
instead of interrupting games. Do not create files at that reserved path.
The global reset coordinator deploys the exact queued SHA explicitly through
`serviceInstanceDeployV2` after cashouts, sweep, and game-session draining.

For bootstrap/recovery, explicitly redeploy the skipped deployment for the
required new SHA. Redeploying the last successful deployment reuses OLD source
and may reuse its configuration snapshot. It does not update to main HEAD.
Always verify `/ready.version`, not just Railway's SUCCESS status.

`RAILWAY_PROJECT_TOKEN` (sealed) or `RAILWAY_API_TOKEN`, `RAILWAY_SERVICE_ID`,
and `RAILWAY_ENVIRONMENT_ID` must be present in the running process. Startup
logs report presence only. Never overwrite a sealed token based on redacted
variable-list output.

A successful sweep is not proof of deployment. Check the separate deployment
outcome, the release queue's `lastError`, and the new `/ready.version`.
