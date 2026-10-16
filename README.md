# Uncex

**Drop the invoice. Keep the $UNCEX.**

[![Live site](https://img.shields.io/badge/site-uncex.fun-38F6B6?style=flat-square&labelColor=030706)](https://uncex.fun)
[![Chain](https://img.shields.io/badge/chain-Solana-367254?style=flat-square&labelColor=030706)](https://solana.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-E4E6DC?style=flat-square&labelColor=030706)](LICENSE)

| | |
|---|---|
| Chain | Solana |
| Contract address | _pending, will be added here once stated_ |
| Site | https://uncex.fun |

## Overview

Uncex is a token project on Solana built around one idea: a single position in the token should open recurring assistant sessions, with no card on file and no renewal to dodge. This repository holds the static site served at uncex.fun.

## Features

- Live Solana market board: the ten tokens with the highest 24h volume, with logo, price, change, volume, liquidity and a per-token address button.
- Streaming ticker built from the same feed, with backoff on failure and a pause while the tab is hidden.
- Contract address slot pinned to the top of the page, click to copy, inert until the address is stated.
- Register-driven content: every external fact (address, social links, rates) is one record in `src/register.json` and stays inert until it is stated.
- Motion with a full reduced-motion fallback.

## Links

- Site: https://uncex.fun
- X: _pending_
- GitHub: _pending_
- Whitepaper: [docs/whitepaper.md](docs/whitepaper.md)

## Build

```bash
npm install
npm run build   # writes dist/, the folder you upload
npm run gates   # builds, then checks every rule
```

## License

MIT, see [LICENSE](LICENSE).
