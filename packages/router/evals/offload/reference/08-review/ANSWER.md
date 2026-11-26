# Review of review/sample.diff

The change to `average()`'s loop bound is an off-by-one bug: `for (let i = 0; i <= nums.length; i++)`
runs one iteration too many, reading `nums[nums.length]`, which is `undefined`. Adding `undefined`
to `sum` makes it `NaN`, so `average()` would return `NaN` for every non-empty array. The loop
bound should stay `i < nums.length`; this diff should not be merged as written.
