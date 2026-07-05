import * as solanaWeb3 from '@solana/web3.js';
const connection = new solanaWeb3.Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const pubKey = new solanaWeb3.PublicKey('55Q7QDNn7NX4ZPJS3bamPGaKokVhEAcfWUUJod6gf9p8');
connection.getBalance(pubKey).then(val => {
    console.log('Balance SOL:', val / 1e9);
}).catch(err => {
    console.error(err);
});
