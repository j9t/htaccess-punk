# .htaccess Punk

[![npm version](https://img.shields.io/npm/v/htaccess-punk.svg)](https://www.npmjs.com/package/htaccess-punk) [![Build status](https://github.com/j9t/htaccess-punk/workflows/Tests/badge.svg)](https://github.com/j9t/htaccess-punk/actions) [![Socket](https://badge.socket.dev/npm/package/htaccess-punk)](https://socket.dev/npm/package/htaccess-punk) [![GitHub Sponsors](https://badgen.net/static/Support/Open%20Source/cyan)](https://github.com/j9t/htaccess-punk?sponsor=1)

.htaccess Punk checks the redirect targets defined in `.htaccess` files. It follows redirect chains to verify where they ultimately resolve and what HTTP status they return, thus helping to fight redirect rot.

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

const { files, urls, urlToFiles, results } = await check('/path/to/dir');
```

`urlToFiles` is a `Map<string, string[]>` of each target URL to the `.htaccess` files that reference it. `results` is an array of objects:

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
3. **skips** targets that contain regex backreferences (`$1`, `%1`, etc.)—these depend on the matched request path and can’t be checked without it
4. **deduplicates** targets across all files
5. **checks** each unique URL with a HEAD request (falling back to GET if the server returns 403 or 405), following redirect chains up to 10 hops, and reports the final HTTP status

The `check()` function returns raw result data. The CLI (`bin/htaccess-punk.js`) collects those results and prints them grouped by `.htaccess` file, with the final status color-coded: green for 2xx, yellow for 3xx (further redirect from the final hop, e.g. a loop or exceeded redirect limit), red for 4xx/5xx. When a target redirected before settling, the final URL is shown below it.

***

You might like some of my other work:

* Optimization tools: [HTML Minifier Next](https://github.com/j9t/html-minifier-next) · [ObsoHTML](https://github.com/j9t/obsohtml) · [Image Guard](https://github.com/j9t/image-guard) · [Compressor.js Next](https://github.com/j9t/compressorjs-next) · .htaccess Punk
* Defense tools: [IA Defensa](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) (including [_On Web Development_](https://meiert.com/blog/on-web-development-2/)) · [News](https://frontenddogma.com/) · [Terminology](https://webglossary.info/)