import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createRailwayDeployer,
    currentReleaseSha,
    normalizeCommitSha,
    secretsMatch,
} from './release-coordinator.js';

const SHA = 'a'.repeat(40);

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
