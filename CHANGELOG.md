# Changelog

All notable changes to .htaccess Punk are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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