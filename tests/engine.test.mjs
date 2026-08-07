import { computeOwed, computePaid, computeBalances, settleUp, validateExpense } from "../js/split.js";
import { splitEvenly, splitByWeights, toMinor, formatMoney } from "../js/money.js";

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL: ${msg}\n   expected ${e}\n   got      ${a}`); }
}

// splitEvenly sums exactly and distributes remainder
eq(splitEvenly(1000, 3), [334, 333, 333], "1000/3 remainder distribution");
eq(splitEvenly(1000, 3).reduce((a,b)=>a+b,0), 1000, "1000/3 sums exact");
eq(splitEvenly(1001, 4), [251, 250, 250, 250], "1001/4");

// splitByWeights largest-remainder, sums exact
eq(splitByWeights(1000, [1,1,1]), [334, 333, 333], "weights equal");
eq(splitByWeights(1000, [50,30,20]).reduce((a,b)=>a+b,0), 1000, "percent sums exact");
eq(splitByWeights(1000, [50,30,20]), [500,300,200], "percent split");

// equal expense
const e1 = { amountMinor: 3000, currency: "USD", paidBy: [{memberId:"A", amountMinor:3000}], split: { type:"equal", participants:["A","B","C"] } };
eq([...computeOwed(e1).entries()], [["A",1000],["B",1000],["C",1000]], "equal owed");
eq(validateExpense(e1), [], "equal validates");

// itemized: A had $20 item, B had $10 item, shared $6 tax across both
const e2 = { amountMinor: 3600, currency:"USD", paidBy:[{memberId:"A", amountMinor:3600}],
  split: { type:"items", items:[{name:"steak",amountMinor:2000,participants:["A"]},{name:"salad",amountMinor:1000,participants:["B"]}], sharedMinor:600 } };
const owed2 = computeOwed(e2);
eq(owed2.get("A"), 2300, "itemized A = 2000 + 300 tax");
eq(owed2.get("B"), 1300, "itemized B = 1000 + 300 tax");
eq(validateExpense(e2), [], "itemized validates");

// percent split
const e3 = { amountMinor: 10000, currency:"USD", paidBy:[{memberId:"A",amountMinor:10000}],
  split:{ type:"percent", participants:["A","B"], weights:[60,40] } };
eq([...computeOwed(e3).values()], [6000,4000], "percent owed");

// balances + settle-up, single currency
// A paid 3000 split equally A/B/C -> A +2000, B -1000, C -1000
const bal = computeBalances([e1], "USD");
eq([...bal.base.entries()].sort(), [["A",2000],["B",-1000],["C",-1000]], "balances base");
const transfers = settleUp(bal.base);
// B and C each pay A 1000
eq(transfers.length, 2, "two transfers");
eq(transfers.every(t=>t.to==="A"&&t.amountMinor===1000), true, "both pay A 1000");

// smart settle-up reduces transactions: circular debt
// A owes B 10, B owes C 10, C owes A 10 -> nets all zero -> 0 transfers
const net = new Map([["A",0],["B",0],["C",0]]);
eq(settleUp(net).length, 0, "circular nets to zero");

// classic reduction: A+15, B+5, C-10, D-10 -> should be 2 or 3 transfers, all balanced
const net2 = new Map([["A",1500],["B",500],["C",-1000],["D",-1000]]);
const t2 = settleUp(net2);
const moved = t2.reduce((a,t)=>a+t.amountMinor,0);
eq(moved, 2000, "total moved equals total debt");
// verify every balance clears
const check = new Map(net2);
for (const t of t2){ check.set(t.from, check.get(t.from)+t.amountMinor); check.set(t.to, check.get(t.to)-t.amountMinor); }
eq([...check.values()].every(v=>v===0), true, "all balances clear after settle-up");

// multi-currency: 1 USD expense + 1 EUR expense at fx 1.1
const eUSD = { amountMinor:2000, currency:"USD", paidBy:[{memberId:"A",amountMinor:2000}], split:{type:"equal",participants:["A","B"]} };
const eEUR = { amountMinor:1000, currency:"EUR", fxToBase:1.1, paidBy:[{memberId:"B",amountMinor:1000}], split:{type:"equal",participants:["A","B"]} };
const balMC = computeBalances([eUSD,eEUR],"USD");
// USD: A +1000, B -1000. EUR 10.00*1.1=11.00 base: B paid 11 split A/B(5.50 each)-> B +5.50, A -5.50 => 550 minor
// net base: A = 1000-550=450 ; B=-1000+550=-450
eq(bal_round(balMC.base.get("A")), 450, "multicurrency A net");
eq(bal_round(balMC.base.get("B")), -450, "multicurrency B net");

function bal_round(x){return x;}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
