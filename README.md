# ShouldISlab

Tells you whether paying to grade a trading card is actually worth it.

**Live:** [shouldislab.com](https://www.shouldislab.com)

Search a card and it pulls recent sold prices at each PSA grade, plus the card's real population report, then works out what you'd net from grading after the grading fee and selling fees.

Most grading calculators show what you'd make if the card comes back a 10. This one weighs every grade by how often it really happens. On a 1999 Base Charizard, about 0.5% of submissions get a 10 and 58% grade 6 or below, so the "if it gems" number is mostly fiction.

The [/invest](https://www.shouldislab.com/invest) page answers the other question: the most you should pay for a raw card you plan to grade, with a slider that shows how the outcomes shift at each price.

## How it works

- **Prices:** the median of recent sales at each grade from the CardHedge API. Median, not mean: a few big sales were dragging the mean about 65% high.
- **Odds:** real submission counts from GemRate. Each gem rate comes with a 95% Wilson score interval, so a rate measured on 12 cards isn't presented like one measured on 100,000.
- **Rate limits:** CardHedge allows about 10 requests per 35 seconds, and one verdict can take 7 calls. An in-memory cache (10 minutes for searches, 6 hours for prices, 24 hours for population data) keeps a second search from getting throttled. If a 429 still comes back, the server fails fast and the page shows a retry countdown instead of hanging.
- **Missing grades:** a grade with no recent sales is filled from CardHedge's price estimate only if the estimate is based on at least two real grades of the same card. Otherwise it shows as "no recent sales," never $0.

## Stack

Node.js, Express, vanilla JavaScript, HTML, CSS. Hosted on Render behind Cloudflare.

## Run it locally

```bash
cd server
npm install
```

Add `server/.env` with your API keys:

```
cardHedger=your_cardhedge_key
gemRate=your_gemrate_key
```

Then run `npm start` and open http://localhost:5000.
