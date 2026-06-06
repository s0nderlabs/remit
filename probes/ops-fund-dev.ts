// One-off ops script (Jun 5 2026, elpabl0-authorized): main.deployer ETH -> dev.deployer,
// swap ETH->USDC on Uniswap v3 (Base), forward USDC to the remit probe throwaway.
import {
  createPublicClient, createWalletClient, http, formatEther, formatUnits, erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { execFileSync } from "child_process";

const RPC = "https://mainnet.base.org";
const pub = createPublicClient({ chain: base, transport: http(RPC) });

const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as const;
const THROWAWAY = "0x5117715db9A94F66E56Cb564728615842DC07bba" as const;

function keyFromKeychain(svc: string) {
  let k = execFileSync("security", ["find-generic-password", "-s", svc, "-w"], { encoding: "utf8" }).trim();
  if (!k.startsWith("0x")) k = "0x" + k;
  return k as `0x${string}`;
}

const mainAcct = privateKeyToAccount(keyFromKeychain("main.deployer"));
const devAcct = privateKeyToAccount(keyFromKeychain("dev.deployer"));
if (mainAcct.address.toLowerCase() !== "0x9a14215fe99e55b2bfafaa89e175838e246f4c81") throw new Error("main key mismatch");
if (devAcct.address.toLowerCase() !== "0xc635e6eb223ae14143e23ceea9440bc773dc87ec") throw new Error("dev key mismatch");

const mainWallet = createWalletClient({ account: mainAcct, chain: base, transport: http(RPC) });
const devWallet = createWalletClient({ account: devAcct, chain: base, transport: http(RPC) });

// ---- Step 1: main -> dev (ETH, balance minus gas headroom) ----
const fees = await pub.estimateFeesPerGas();
const maxFee = fees.maxFeePerGas!;
const mainBal = await pub.getBalance({ address: mainAcct.address });
const gasHeadroom = 21000n * maxFee * 2n + 2_000_000_000_000n; // 2x gas + l1-data buffer
const sendValue = mainBal - gasHeadroom;
if (sendValue <= 0n) throw new Error(`main balance too small: ${formatEther(mainBal)}`);
console.log(`1) main -> dev: ${formatEther(sendValue)} ETH (bal ${formatEther(mainBal)}, maxFee ${maxFee})`);
const h1 = await mainWallet.sendTransaction({ to: devAcct.address, value: sendValue });
const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
console.log(`   tx ${h1} -> ${r1.status}`);

// ---- Step 2: dev swaps ETH -> USDC (keep gas reserve) ----
const devBal = await pub.getBalance({ address: devAcct.address });
const reserve = 40_000_000_000_000n + 250_000n * maxFee * 2n; // 0.00004 ETH + swap gas headroom
const amountIn = devBal - reserve;
if (amountIn <= 0n) throw new Error(`dev balance too small: ${formatEther(devBal)}`);
console.log(`2) dev swap: ${formatEther(amountIn)} ETH -> USDC (bal ${formatEther(devBal)})`);

const quoterAbi = [{
  name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ]}],
  outputs: [
    { name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" },
  ],
}] as const;

const { result: quote } = await pub.simulateContract({
  address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle",
  args: [{ tokenIn: WETH, tokenOut: USDC, amountIn, fee: 500, sqrtPriceLimitX96: 0n }],
});
const amountOut = quote[0];
const minOut = (amountOut * 99n) / 100n;
console.log(`   quote: ${formatUnits(amountOut, 6)} USDC (minOut ${formatUnits(minOut, 6)})`);

const routerAbi = [{
  name: "exactInputSingle", type: "function", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ]}],
  outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;

const h2 = await devWallet.writeContract({
  address: SWAP_ROUTER_02, abi: routerAbi, functionName: "exactInputSingle",
  args: [{ tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: devAcct.address,
    amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  value: amountIn,
});
const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
console.log(`   tx ${h2} -> ${r2.status}`);

// ---- Step 3: dev -> throwaway (full USDC balance) ----
const usdcBal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [devAcct.address] });
console.log(`3) dev -> throwaway: ${formatUnits(usdcBal, 6)} USDC`);
const h3 = await devWallet.writeContract({
  address: USDC, abi: erc20Abi, functionName: "transfer", args: [THROWAWAY, usdcBal],
});
const r3 = await pub.waitForTransactionReceipt({ hash: h3 });
console.log(`   tx ${h3} -> ${r3.status}`);

// ---- Final state ----
for (const [name, addr] of [["main", mainAcct.address], ["dev", devAcct.address], ["throwaway", THROWAWAY]] as const) {
  const [u, e] = await Promise.all([
    pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
    pub.getBalance({ address: addr }),
  ]);
  console.log(`   ${name}: ${formatUnits(u, 6)} USDC, ${formatEther(e)} ETH`);
}
