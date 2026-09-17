WORLDREADER READING OLYMPICS - LOCAL PROTOTYPE

Run:
  1. Install Node.js 18+.
  2. Open Terminal in this folder.
  3. Run: npm start
  4. Open: http://localhost:3000

What it does:
  - Fetches https://www.worldreader.org/challenges-stats/current.json through a local Node proxy.
  - Attempts to auto-detect country, participant, books-completed, completion, and points fields.
  - Ranks eligible countries by average points per active reader.
  - Uses completion percentage as a tiebreaker.
  - Defaults to 10 points per completed book, max 100 points per reader, 10 books for completion, and a 5-reader country threshold.
  - Includes a Raw Data tab for validating and refining the current.json field mapping.
  - Falls back to demo data if the live feed is unavailable or cannot be parsed.

Important:
  The originally assumed /challenges-stats/current.json URL returns a 404 HTML page as of September 17, 2026.
  Open Raw Data and enter the password for the protected Challenges Stats page, then click Discover JSON URL.
  The password is sent only to the local Node server and is not stored.
  Discovery checks the protected page plus linked Worldreader scripts and frames. If it still finds no endpoint,
  the Raw Data panel lists what it inspected and gives the next diagnostic step.

Live field mapping:
  - totals.<country code>.joined = active readers
  - totals.<country code>.finishedBook = books completed
  - totals.<country code>.completed = challenge finishers
  - totals.<country code>.finishedTip is retained but is not part of the leaderboard score
