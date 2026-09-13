/**
 * Small in-process FIFO used for wallets that have a single spendable SOL
 * balance. Without serialization, two callers can both read the same balance
 * and then race each other during preflight/broadcast.
 */
export function createSerialOperationQueue() {
    let tail = Promise.resolve();
    let queued = 0;

    return {
        run(operation) {
            queued += 1;
            const result = tail.then(operation, operation);
            tail = result.then(
                () => { queued = Math.max(0, queued - 1); },
                () => { queued = Math.max(0, queued - 1); },
            );
            return result;
        },
        get size() {
            return queued;
        },
    };
}
