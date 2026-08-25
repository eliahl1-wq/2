import test from 'node:test';
import assert from 'node:assert/strict';
import { getRewardPoolSplit } from './economy.js';
import { getStarterRewardFundingRequirements } from './free-ticket-funding.js';

for (const rewardUsd of [0, 0.01, 4.99, 5, 5.01, 9.99, 10, 24.75]) {
    test(`starter reward $${rewardUsd} is fully funded by its required Normal games`, () => {
        const requirements = getStarterRewardFundingRequirements(rewardUsd);
        const fundedUsd = requirements.req5 * getRewardPoolSplit(5).rewardPoolContribution
            + requirements.req10 * getRewardPoolSplit(10).rewardPoolContribution;

        assert.equal(fundedUsd, requirements.fundingTargetUsd);
        assert.ok(fundedUsd >= Math.max(5, rewardUsd));
    });
}
