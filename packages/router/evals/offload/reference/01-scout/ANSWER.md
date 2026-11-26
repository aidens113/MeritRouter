# Scout finding

`formatCurrencyCents` in `src/money.ts` builds the string as `` `$${dollars.toFixed(2)}` ``.
`toFixed` keeps the minus sign attached to the number, so for -150 cents
(`dollars = -1.5`) it returns `$-1.50` — the dollar sign ends up in front of the minus sign.

The correct output for `formatCurrencyCents(-150)` is `-$1.50` (the sign in front of the dollar
sign), not the current `$-1.50`.
