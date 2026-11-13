import { timingSafeEqual } from 'node:crypto';

export const RELEASE_PHASES = Object.freeze({
    IDLE: 'idle',
    PENDING: 'pending',
    RESETTING: 'resetting',
    DEPLOYING: 'deploying',
    FAILED: 'failed',
});

export function normalizeCommitSha(value) {
    const sha = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export function secretsMatch(actual, expected) {
    if (!actual || !expected) return false;
    const left = Buffer.from(String(actual));
    const right = Buffer.from(String(expected));
    return left.length === right.length && timingSafeEqual(left, right);
}

export function currentReleaseSha(env = process.env) {
    return normalizeCommitSha(
        env.RAILWAY_GIT_COMMIT_SHA
        || env.RELEASE_SHA
        || env.GIT_COMMIT_SHA,
    );
}

export function createRailwayDeployer({
    fetchImpl,
    token,
    projectToken,
    serviceId,
    environmentId,
    endpoint = 'https://backboard.railway.com/graphql/v2',
    requestTimeoutMs = 20_000,
    verifyStatus = false,
}) {
    return async function deployCommit(commitSha) {
        const normalizedSha = normalizeCommitSha(commitSha);
        if (!normalizedSha) throw new Error('Pending release has an invalid commit SHA');
        const missing = [];
        if (!fetchImpl) missing.push('HTTP client');
        if (!String(token || '').trim() && !String(projectToken || '').trim()) missing.push('RAILWAY_PROJECT_TOKEN or RAILWAY_API_TOKEN');
        if (!String(serviceId || '').trim()) missing.push('RAILWAY_SERVICE_ID');
        if (!String(environmentId || '').trim()) missing.push('RAILWAY_ENVIRONMENT_ID');
        if (missing.length) throw new Error(`Railway deployment configuration missing: ${missing.join(', ')}. Apply these variables to the running deployment.`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    ...(projectToken
                        ? { 'Project-Access-Token': projectToken }
                        : { Authorization: `Bearer ${token}` }),
                    'Content-Type': 'application/json',
                },
                signal: controller.signal,
                body: JSON.stringify({
                    query: `mutation DeployScheduledRelease($serviceId: String!, $environmentId: String!, $commitSha: String!) {
                        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
                    }`,
                    variables: { serviceId, environmentId, commitSha: normalizedSha },
                }),
            });
        } finally {
            clearTimeout(timeout);
        }

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.errors?.length) {
            const detail = payload.errors?.map(error => error.message).filter(Boolean).join('; ')
                || `Railway returned HTTP ${response.status}`;
            throw new Error(detail);
        }
        const deploymentId = payload.data?.serviceInstanceDeployV2;
        if (!deploymentId) throw new Error('Railway did not return a deployment id');
        if (!verifyStatus) return { deploymentId, commitSha: normalizedSha };
        const request = async (query, variables) => {
            const response = await fetchImpl(endpoint, {
                method: 'POST', headers: projectToken
                    ? { 'Project-Access-Token': projectToken, 'Content-Type': 'application/json' }
                    : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(requestTimeoutMs),
                body: JSON.stringify({ query, variables }),
            });
            const body = await response.json();
            if (!response.ok || body.errors?.length) throw new Error(body.errors?.map(e => e.message).join('; ') || `Railway HTTP ${response.status}`);
            return body.data;
        };
        const startedId = await ensureRailwayDeploymentStarted(request, deploymentId);
        return { deploymentId: startedId, commitSha: normalizedSha };
    };
}

// Watch paths suppress GitHub pushes, and may also skip an explicit commit
// build. At the already-drained reset boundary, force that SAME deployment's
// commit to build. Never redeploy whichever older commit happened to be live.
export async function ensureRailwayDeploymentStarted(request, deploymentId, {
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = Date.now, timeoutMs = 180_000,
} = {}) {
    const deadline = now() + timeoutMs;
    let id = deploymentId;
    let forced = false;
    while (now() < deadline) {
        const data = await request('query ResetDeploymentStatus($id: String!) { deployment(id: $id) { id status } }', { id });
        const status = data?.deployment?.status;
        if (status === 'DEPLOYING' || status === 'SUCCESS') return id;
        if (status === 'SKIPPED') {
            if (forced) throw new Error('Railway skipped the forced reset deployment');
            const result = await request('mutation ForceResetDeployment($id: String!) { deploymentRedeploy(id: $id, usePreviousImageTag: false) { id } }', { id });
            id = result?.deploymentRedeploy?.id;
            if (!id) throw new Error('Railway did not return a forced deployment id');
            forced = true;
        } else if (['FAILED', 'CRASHED', 'REMOVED'].includes(status)) {
            throw new Error(`Railway reset deployment ${id} ${status.toLowerCase()}`);
        }
        await delay(2000);
    }
    throw new Error(`Railway reset deployment ${id} did not start before the deadline`);
}
