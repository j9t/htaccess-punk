# .htaccess Punk

<!-- [![npm version](https://img.shields.io/npm/v/htaccess-punk.svg)](https://www.npmjs.com/package/htaccess-punk) --> [![Build status](https://github.com/j9t/htaccess-punk/workflows/Tests/badge.svg)](https://github.com/j9t/htaccess-punk/actions) <!-- [![Socket](https://badge.socket.dev/npm/package/htaccess-punk)](https://socket.dev/npm/package/htaccess-punk) -->

.htaccess Punk checks the redirect targets defined in `.htaccess` files—following redirect chains to verify where they ultimately resolve and what HTTP status they return.

## Usage

### CLI Use

```shell
npx htaccess-punk [options] [directory]
```

`directory` defaults to the current working directory. .htaccess Punk scans it recursively.

| Option | Short | Description |
|---|---|---|
| `--errors` | `-e` | Show only error results (HTTP 4xx+ and connection failures); summary still reflects all checked URLs |
| `--help` | `-h` | Show usage information |

### Programmatic Use

```javascript
import { check } from 'htaccess-punk';

const { files, urls, results } = await check('/path/to/dir');
```

`results` is an array of objects:

```javascript
{
  url,      // original target URL
  status,   // final HTTP status code
  finalUrl, // final URL after following redirects (null if no redirects)
  chain,    // array of `{ url, status }` for each hop
  error,    // error message if the request failed (`status` and `finalUrl` absent)
}
```

`check()` also accepts an options object:

```javascript
await check(dir, {
  concurrency: 5,               // parallel requests (default: 5)
  onReady({ files, urls }) {},  // called after files are found and targets extracted
  onResult(result) {},          // called for each result as it comes in
});
```

## How It Works

.htaccess Punk:

1. **finds** all `.htaccess` files in the given directory, recursively (skipping `node_modules` and `.git`)
2. **parses** `Redirect`, `RedirectPermanent`, `RedirectTemp`, `RedirectMatch`, and `RewriteRule` directives to extract absolute target URLs
3. **skips** targets that contain regex backreferences (`$1`, `%1`, etc.)—these depend on the matched request path and can't be checked without it
4. **deduplicates** targets across all files
5. **checks** each unique URL with a HEAD request (falling back to GET if the server returns 403 or 405), following redirect chains up to 10 hops, and reports the final HTTP status

Results are collected while checking runs, then printed grouped by `.htaccess` file. The final status is color-coded: green for 2xx, yellow for 3xx (further redirect from the final hop, e.g. a loop or exceeded redirect limit), red for 4xx/5xx. When a target redirected before settling, the final URL is shown below it.