// Mainnet (8453) repeat of key rows with a fresh UNFUNDED key.
// Confirms cross-chain consistency of the validation order and Plan A.
import { runBaseline } from "./probe1-baseline";
import { runChain2 } from "./probe2-chain2";
import { runMatrix } from "./probe4-caveat-matrix";

await runBaseline(8453); // probe 1
await runChain2(8453, "leaf,root"); // probe 2 Plan A
await runChain2(8453, "root,leaf"); // ordering check
await runChain2(8453, "leaf,root", { doubleAuth: true }); // exactly-one-auth guard
await runMatrix(8453); // full caveat matrix on mainnet
