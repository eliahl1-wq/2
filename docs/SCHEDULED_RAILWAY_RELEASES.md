# Scheduled Railway releases

Backend releases are queued by GitHub and deployed only after the next successful scheduled arena reset. Manual/admin resets do not deploy code.

## One-time production setup

The local repository was not linked to a Railway project and no Railway CLI or Railway environment metadata was available during implementation, so the live service IDs and settings must be entered in the provider UIs once.

1. In the Railway backend service, disable GitHub automatic deployments. Keep the service connected to `eliahl1-wq/2` and `main`; exact-SHA deployments need that source connection.
2. In Railway service settings, set the healthcheck path to `/ready`, the healthcheck timeout to 600 seconds, and draining to 30 seconds.
3. Add these Railway backend variables and seal sensitive values:
   - `RELEASE_QUEUE_SECRET`: a long random secret shared only with GitHub Actions.
   - `RAILWAY_PROJECT_TOKEN`: a project token created for the production environment. Railway supplies `RAILWAY_SERVICE_ID` and `RAILWAY_ENVIRONMENT_ID` automatically.
   - `RELEASE_MAINTENANCE_TIMEOUT_MS`: optional; defaults to 20 minutes and must be longer than the expected build plus readiness time.
4. In GitHub repository `eliahl1-wq/2`, add Actions secrets:
   - `RELEASE_QUEUE_URL`: the public backend origin, without a trailing slash.
   - `RELEASE_QUEUE_SECRET`: the same random value configured in Railway.
5. Bootstrap this release once: disable autodeploy first, push the implementation, then use Railway's **Deploy Latest Commit** once. After it is ready, manually run the **Queue production release** workflow if its bootstrap push could not reach the new queue endpoint.

Do not place the Railway token, service ID, environment ID, or queue secret in the frontend repository or in any `VITE_` variable.

## Runtime flow

1. A push to `main` runs `.github/workflows/queue-production-release.yml`, which registers the exact 40-character commit SHA in MongoDB. It does not call Railway.
2. The normal three-hour arena scheduler claims the newest pending SHA and enables deployment maintenance before cashouts begin.
3. Existing reset behavior settles player cashouts and the house-wallet sweep. A deferred or failed reset requeues the release and removes deployment maintenance.
4. Because the existing arena reset intentionally leaves tournaments and Battle Royale untouched, an active tournament session defers the release, while BR matches and paid queues get up to eight minutes to drain. If they do not drain, the release is safely requeued instead of discarding in-memory match state.
5. Only after `reset_complete` and the BR drain gate does the backend call Railway's `serviceInstanceDeployV2` mutation with that exact SHA.
6. The old process returns HTTP 503 from `/ready` while the deployment is pending. The frontend shows the update banner and keeps new joins disabled.
7. The new process returns HTTP 200 only after MongoDB, reward state, affiliate tiers/reconciliation, shared-wallet blocks, and release recovery have initialized. It then clears deployment maintenance. The manual admin join lock remains independent.
8. If the deploy never becomes ready, the old process clears maintenance after the timeout and puts the SHA back in the queue for the next scheduled reset.

`/api/health` remains a liveness check. `/ready` and `/api/ready` are dependency-aware readiness checks.
