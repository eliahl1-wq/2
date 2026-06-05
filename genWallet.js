import * as solanaWeb3 from '@solana/web3.js';

// Skapa en slumpmässig plånbok
const wallet = solanaWeb3.Keypair.generate();

console.log("====================================================");
console.log("   DIN NYA HOUSE WALLET (OPERATIV PLÅNBOK)   ");
console.log("====================================================");
console.log("\n1. Lägg till denna som HOUSE_WALLET_ADDRESS i Railway/env:");
console.log(wallet.publicKey.toBase58());

console.log("\n2. Lägg till denna som HOUSE_WALLET_SECRET i Railway/env (HEX-FORMAT):");
console.log(Buffer.from(wallet.secretKey).toString('hex'));
console.log("\n====================================================");
console.log("VIKTIGT: Spara SECRET_KEY på ett säkert ställe offline!");