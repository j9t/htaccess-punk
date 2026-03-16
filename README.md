# .htaccess Punk

.htaccess Punk checks the redirect targets defined in `.htaccess` files—following redirect chains to verify where they ultimately resolve and what HTTP status they return.

## Usage

```
npx htaccess-punk [directory]
```

`directory` defaults to the current working directory. .htaccess Punk scans it recursively.

## How It Works

.htaccess Punk:

1. **finds** all `.htaccess` files in the given directory, recursively (skipping `node_modules` and `.git`)
2. **parses** `Redirect`, `RedirectPermanent`, `RedirectTemp`, `RedirectMatch`, and `RewriteRule` directives to extract absolute target URLs
3. **skips** targets that contain regex backreferences (`$1`, `%1`, etc.)—these depend on the matched request path and can't be checked without it
4. **deduplicates** targets across all files
5. **checks** each unique URL with a HEAD request, following redirect chains up to 10 hops, and reports the final HTTP status

Results are printed as they come in, with the final status color-coded: green for 2xx, yellow for 3xx (further redirect from the final hop, e.g. a loop or exceeded redirect limit), red for 4xx/5xx. When a target redirected before settling, the final URL is shown below it.

## Programmatic Use

```js
import { check } from 'htaccess-punk';

const { files, urls, results } = await check('/path/to/dir');
```

`results` is an array of objects:

```js
{
  url,      // original target URL
  status,   // final HTTP status code
  finalUrl, // final URL after following redirects (null if no redirects)
  chain,    // array of { url, status } for each hop
  error,    // error message if the request failed (status and chain absent)
}
```

`check()` also accepts an options object:

```js
await check(dir, {
  concurrency: 5,               // parallel requests (default: 5)
  onReady({ files, urls }) {},  // called after files are found and targets extracted
  onResult(result) {},          // called for each result as it comes in
});
```
