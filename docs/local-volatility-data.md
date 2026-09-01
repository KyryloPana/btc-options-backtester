
## Normal local research-bundle export

The normal UI export is offline and requires both prepared-data locations. In PowerShell, set them before starting the app:

```powershell
$env:BTC_OPTIONS_LOCAL_DATA_ROOT="D:\BTCOptionsData"
$env:BTC_OPTIONS_VOLATILITY_CACHE_ROOT="D:\BTCOptionsData\volatility-reference-cache"
npm run dev
```

Use the normal research-bundle export in the UI. The external reference cache is used in place; it does not need to be copied into the repository. A missing, incomplete, out-of-coverage, or source-fingerprint-incompatible cache is rejected with instructions to run `npm run volatility:precompute-local`.
