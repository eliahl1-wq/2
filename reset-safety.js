export async function waitForActiveSetToDrain(activeSet, {
    maxWaitMs = 180_000,
    pollMs = 100,
    now = () => Date.now(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    const deadline = now() + Math.max(0, Number(maxWaitMs) || 0);
    while (activeSet?.size > 0 && now() < deadline) {
        await delay(Math.max(1, Number(pollMs) || 1));
    }
    return (activeSet?.size || 0) === 0;
}
