// Match entry still requires confirmed/finalized authority. HTTP is a second
// observation channel for the SAME signature, never another payment attempt.
export async function confirmEntrySignature(connection, signature, transaction, { pollMs = 500 } = {}) {
    const controller = new AbortController();
    let stopped = false;
    let timer;
    let wake;
    const primary = connection.confirmTransaction({ signature,
        blockhash: transaction.recentBlockhash,
        lastValidBlockHeight: transaction.lastValidBlockHeight,
        abortSignal: controller.signal,
    }, 'confirmed');
    const http = (async () => {
        while (!stopped) {
            try {
                const response = await connection.getSignatureStatuses([signature]);
                const status = response?.value?.[0];
                if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
                    return { value: { err: status.err || null } };
                }
            } catch { /* Transient HTTP errors do not replace the SDK confirmation. */ }
            if (stopped) break;
            await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, pollMs); });
            wake = null;
        }
        return new Promise(() => {});
    })();
    try {
        const result = await Promise.race([primary, http]);
        if (result.value.err) throw new Error(`Entry transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
        return signature;
    } finally {
        stopped = true; clearTimeout(timer); wake?.(); controller.abort();
    }
}

export async function sendAndConfirmEntryTransaction(connection, transaction, signers, { lastValidBlockHeight, maxRetries = 3 } = {}) {
    // Reuse the blockhash already fetched alongside balance/rent. The SDK's
    // sendTransaction path fetches its own blockhash again before signing.
    if (Number.isFinite(lastValidBlockHeight)) transaction.lastValidBlockHeight = lastValidBlockHeight;
    if (!transaction.recentBlockhash || !Number.isFinite(transaction.lastValidBlockHeight)) {
        throw new Error('Entry transaction needs a valid blockhash and expiry before submission.');
    }
    transaction.sign(...signers);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: 'confirmed', maxRetries,
    });
    return confirmEntrySignature(connection, signature, transaction);
}
