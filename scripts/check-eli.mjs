import * as solanaWeb3 from '@solana/web3.js';
const connection = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const pubKey = new solanaWeb3.PublicKey('AtMXSx2kn2An1WsXKtnKRSpmsDb1sKUJQP9ghp3uUVBh');
connection.getBalance(pubKey).then(val => {
    console.log('Balance SOL:', val / 1e9);
}).catch(err => {
    console.error(err);
});
