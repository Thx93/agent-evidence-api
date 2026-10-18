# Spending budget for the first-sale goal

The operator set a hard budget of **0.5 USDC** for the goal of producing a first
third-party sale. The rest of the buyer wallet is **not** budget and must not be
spent. This file exists so that rule survives across rounds, because a number in a
chat message gets forgotten and a wallet does not.

## The rule

- Cumulative spend on this goal may never exceed **0.500000 USDC**.
- Anything in the buyer wallet above that allowance belongs to the operator.
- Only the operator's buyer wallet may be spent. The seller wallet
  (`0x9c0e…55FD0`) holds revenue and is never a source of funds.
- Every spend must be a real paid call or a catalogue refresh that costs nothing.
  `/verify` moves no funds, so discovery refreshes are free and are not charging the
  budget at all.

## Accounting

Baseline: buyer wallet held `2.934000` USDC when the goal began.

| round | spent | what for |
| --- | --- | --- |
| 1 | 0.009 | one CDP settlement plus two weather tools' first settled payments — the requirement for an MCP route to be catalogued |
| 2 | 0.003 | verifying a CDP settlement did or did not index us in their Bazaar |
| 3–5 | 0.009 | product verification: a real evidence call, and re-checks after the schema fix |
| 6 | 0.006 | the two paid calls that exposed the misleading "supported" verdict |
| **total** | **0.027** | of 0.500 — **0.473 remaining** |

Every payment so far is the operator's own. None of it is a sale, and none of it is
counted as revenue anywhere.

## Checking it

`scripts/budget-status.sh` reads the chain and reports spend against the allowance.
Run it before any round that intends to spend.
