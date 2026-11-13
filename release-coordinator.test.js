import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRailwayDeployer,
    ensureRailwayDeploymentStarted,
    currentReleaseSha,
    normalizeCommitSha,
    secretsMatch,
} from './release-coordinator.js';

const SHA = 'a'.repeat(40);

test('reset forces the newly queued skipped commit rather than redeploying the old live build', async () => {
    const ids = [];
    let calls = 0;
    const id = await ensureRailwayDeploymentStarted(async (query, variables) => {
        ids.push(variables.id);
        if (query.includes('deploymentRedeploy')) return { deploymentRedeploy: { id: 'forced-new-commit' } };
        return { deployment: { status: calls++ === 0 ? 'SKIPPED' : 'DEPLOYING' } };
    }, 'queued-new-commit', { delay: async () => {} });
    assert.equal(id, 'forced-new-commit');
    assert.deepEqual(ids, ['queued-new-commit', 'queued-new-commit', 'forced-new-commit']);
});

test('reset reports a failed Railway build instead of claiming deployment started', async () => {
    await assert.rejects(() => ensureRailwayDeploymentStarted(async () => ({ deployment: { status: 'FAILED' } }), 'new-commit'), /failed/);
});

test('normalizes only full Git commit SHAs', () => {
    assert.equal(normalizeCommitSha(` ${SHA.toUpperCase()} `), SHA);
    assert.equal(normalizeCommitSha('abc123'), null);
});

test('reads the Railway commit SHA first', () => {
    assert.equal(currentReleaseSha({ RAILWAY_GIT_COMMIT_SHA: SHA, RELEASE_SHA: 'b'.repeat(40) }), SHA);
});

test('compares queue secrets without accepting missing values', () => {
    assert.equal(secretsMatch('secret', 'secret'), true);
    assert.equal(secretsMatch('secret', 'different'), false);
    assert.equal(secretsMatch('', ''), false);
});

test('deploys the exact pending commit through Railway GraphQL', async () => {
    let request;
    const deploy = createRailwayDeployer({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, json: async () => ({ data: { serviceInstanceDeployV2: 'deployment-1' } }) };
        },
        token: 'server-only-token',
        serviceId: 'service-1',
        environmentId: 'environment-1',
    });

    assert.deepEqual(await deploy(SHA), { deploymentId: 'deployment-1', commitSha: SHA });
    const body = JSON.parse(request.options.body);
    assert.equal(body.variables.commitSha, SHA);
    assert.equal(request.options.headers.Authorization, 'Bearer server-only-token');
});

test('surfaces Railway GraphQL failures', async () => {
    const deploy = createRailwayDeployer({
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ errors: [{ message: 'Commit not found' }] }),
        }),
        token: 'token',
        serviceId: 'service',
        environmentId: 'environment',
    });
    await assert.rejects(() => deploy(SHA), /Commit not found/);
});

test('uses the environment-scoped Railway project token when configured', async () => {
    let headers;
    const deploy = createRailwayDeployer({
        fetchImpl: async (_url, options) => {
            headers = options.headers;
            return { ok: true, json: async () => ({ data: { serviceInstanceDeployV2: 'deployment-2' } }) };
        },
        projectToken: 'project-token',
        serviceId: 'service',
        environmentId: 'environment',
    });
    await deploy(SHA);
    assert.equal(headers['Project-Access-Token'], 'project-token');
    assert.equal(headers.Authorization, undefined);
});

test('missing deployment configuration names the exact missing inputs without exposing secrets', async () => {
    for (const [overrides, expected] of [
        [{ serviceId: '' }, 'RAILWAY_SERVICE_ID'],
        [{ environmentId: undefined }, 'RAILWAY_ENVIRONMENT_ID'],
        [{ projectToken: '' }, 'RAILWAY_PROJECT_TOKEN or RAILWAY_API_TOKEN'],
    ]) {
        let requested = false;
        const deploy = createRailwayDeployer({
            fetchImpl: async () => { requested = true; },
            projectToken: 'never-print-this-token', serviceId: 'service', environmentId: 'environment',
            ...overrides,
        });
        await assert.rejects(() => deploy(SHA), error => {
            assert.ok(error.message.includes(expected));
            assert.ok(!error.message.includes('never-print-this-token'));
            return true;
        });
        assert.equal(requested, false);
    }
});
