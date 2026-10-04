# Contributing

## Prerequisites

- Node 24
- npm 12
- [uv](https://docs.astral.sh/uv/)

## Setup

Run `npm ci`. Its `prepare` script installs the git hooks and pulls the binaries and audio fixtures the tests need.

## Pull requests

These checks and tests must pass before a pull request is opened:

```sh
npm run check
npm run unit
npx turbo integration
npx turbo run integration:heavy
```

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), and the commit-msg hook enforces it. A commit body states the reasoning for the change and links the code, changes and commits it references with [Inspectory](https://github.com/visionsofparadise/inspectory) links.
