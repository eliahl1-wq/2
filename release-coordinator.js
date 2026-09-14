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
}) {
    return async function deployCommit(commitSha) {
        const normalizedSha = normalizeCommitSha(commitSha);
        if (!normalizedSha) throw new Error('Pending release has an invalid commit SHA');
        if (!fetchImpl || (!token && !projectToken) || !serviceId || !environmentId) {
            throw new Error('Railway release variables are incomplete');
        }

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
        return { deploymentId, commitSha: normalizedSha };
    };
}
