# Changelog

All notable changes to .htaccess Punk are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-10-31

### Fixed

* Ensured `Redirect` and `RedirectMatch` targets are extracted when the status is given as a keyword (`permanent`, `temp`, `seeother`)
* Ensured targets in quoted arguments (as in Apache’s documentation, e.g., `Redirect "/one" "https://example.com/two"`) are extracted in full, including spaces, single quotes, escapes, and unclosed quotes, which Apache reads to the end of the line
* Ensured directives continued over several lines with a trailing backslash are parsed, and that `RewriteRule` targets with escaped spaces, escaped or literal `$`, or a fragment are extracted in full
* Ensured targets Apache never redirects to are skipped: those of directives with a non-3xx status, too many arguments, or malformed flags, of `RewriteRule` directives with `F`, `G`, or a non-3xx `R` flag, and of lines with config variables (`${…}`)
* Ensured `Redirect` targets in expression syntax (e.g., `Redirect 301 https://example.com/`) are extracted
* Ensured `RewriteRule` targets with percent-encoding that Apache leaves literal (e.g., `%C3%A9`) are checked rather than skipped like backreferences
* Ensured `check()` rejects with a `RangeError` for a `concurrency` that isn’t a positive integer, where it previously resolved without checking anything

### Added

* Added an `onInvalid` option to `check()` and `extractTargets()`, called with `{ file, line, reason }` (`{ line, reason }` for `extractTargets()`) for each invalid `Redirect`, `RedirectMatch`, `RedirectPermanent`, `RedirectTemp`, or `RewriteRule` line it detects, which makes Apache fail the whole file (as does a leading byte order mark, which Apache rejects except on Windows); the CLI prints these as warnings

### Changed

* Removed redundant ESLint configuration and an unreachable fallback in the CLI
* Discarded response bodies of `GET` fallback requests, which kept their connections busy

## [2.0.0] - 2026-08-12

### Fixed

* **BREAKING:** Ensured `findHtaccessFiles()` resolves the given directory, so that it always returns absolute paths, matching the `files` that `check()` returns; only calls that passed a relative directory are affected
* Ensured the CLI fails with a message and a non-zero exit when the given path doesn’t exist, isn’t a directory, or can’t be read
* Ensured the CLI reports subdirectories it can’t read, which it used to skip silently

### Added

* Added an `onWarn` option to `check()` and `findHtaccessFiles()`, called with `{ dir, err }` for every subdirectory that can’t be read

### Changed

* **BREAKING:** Changed `check()` and `findHtaccessFiles()` to reject when the given directory doesn’t exist, isn’t a directory, or can’t be read, where they previously resolved to an empty result; the underlying error keeps its `code` (`ENOENT`, `ENOTDIR`, `EACCES`)
* Dropped the version from the `User-Agent` sent with each request

## [1.3.0] - 2026-07-27

### Added

* Added TypeScript declarations

## [1.2.0] - 2026-05-18

### Changed

* Frontloaded variables for improved noun-first consistency, notably `finalUrl` as `urlFinal` but also some internal names

## [1.1.1] - 2026-03-17

### Changed

* Updated README metadata

## [1.1.0] - 2026-03-17

### Added

* Added `--errors`/`-e` flag to only show errors (HTTP 4xx+ and connection failures), suppressing successful and redirected results
* Grouped results by `.htaccess` file

### Changed

* Tightened ESLint configuration—based it on `eslint:recommended`, replaced manual globals with `globals.node`, promoted all warnings to errors, added `no-shadow`, `no-var`, and `prefer-const` rules
* Moved regex constants to module scope
* Parallelized `.htaccess` file reads in `check()`
* Replaced four-pass summary counting with a single loop
* Removed redundant intermediate `allTargets` Set now that `urlToFiles` covers the same data

## [1.0.0] - 2026-03-16

### Added

* Shipped initial release with redirect target checking for `.htaccess` files