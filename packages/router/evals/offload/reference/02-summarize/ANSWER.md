# Log summary

The failing test is `money > formats negative cents with the sign before the dollar sign`.

Root cause: the function under test returns `'$-1.50'` but the test expects `'-$1.50'` — a
dollar-sign vs. minus-sign ordering bug, not a rounding or value bug. The fix belongs in
`formatCurrencyCents` in `src/money.ts`.
