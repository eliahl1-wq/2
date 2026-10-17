export function requireResumeTarget(resumeOnly, player) {
    if (resumeOnly && !player) throw new Error('The previous entry has no active match. Return to the lobby and try again.');
}

export function createJoinWaiters(active) {
    const waiters = new Map();
    return {
        wait(key, timeoutMs = 45_000) {
            if (!active.has(key)) return Promise.resolve(true);
            return new Promise(resolve => {
                const listeners = waiters.get(key) || new Set();
                let timer;
                const finish = completed => {
                    clearTimeout(timer); listeners.delete(finish);
                    if (!listeners.size) waiters.delete(key);
                    resolve(completed);
                };
                listeners.add(finish); waiters.set(key, listeners);
                timer = setTimeout(() => finish(false), timeoutMs);
            });
        },
        finish(key) {
            active.delete(key);
            for (const finish of [...(waiters.get(key) || [])]) finish(true);
        },
    };
}
