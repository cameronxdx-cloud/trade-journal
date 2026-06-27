# Trade Journal

A clean, dark-mode trading journal website. Import CSVs from **Topstep**, **Lucid**, or any broker — view stats, charts, and annotate every trade with notes and tags.

## Features

- **Dashboard** — Total P&L, win rate, profit factor, equity curve, daily P&L bars
- **All Trades** — Searchable, filterable, sortable table with every trade
- **Performance** — P&L by symbol, trades by day of week, P&L histogram
- **Notes & Tags** — Add notes and tags to any trade (saved in your browser)
- **CSV Import** — Supports Topstep, Lucid, and generic broker exports

---

## Getting Started (Local)

No build step required — it's plain HTML/CSS/JS.

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/trade-journal.git
cd trade-journal

# Open in browser (any local server works)
npx serve .
# or: python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

---

## Deploying to GitHub Pages

1. **Create a new GitHub repository** (public or private).

2. **Push this folder:**
   ```bash
   git init
   git add .
   git commit -m "Initial trade journal"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/trade-journal.git
   git push -u origin main
   ```

3. **Enable GitHub Pages:**
   - Go to your repo → **Settings** → **Pages**
   - Source: **Deploy from a branch**
   - Branch: `main` / `/ (root)`
   - Click **Save**

4. Your site will be live at:
   ```
   https://YOUR_USERNAME.github.io/trade-journal/
   ```

---

## Importing Trades

### From Topstep

1. Log in to your Topstep dashboard
2. Go to **Trade History** → **Export**
3. Download as CSV
4. Click **Import CSV** in the journal sidebar

### From Lucid (TopstepX / Earn2Trade)

1. Open your Lucid trading platform
2. Navigate to **Account** → **Trade History**
3. Export as CSV
4. Click **Import CSV**

### Manual / Other Brokers

Use this column format:
```
Date, Symbol, Side, EntryPrice, ExitPrice, PnL
2024-01-03, NQ, Long, 16800.25, 16850.50, 201.00
```

A sample file is included at `data/sample.csv` — import it to see the journal in action.

---

## CSV Column Mapping

The importer auto-detects columns from major platforms:

| Platform | Date | Symbol | Side | Entry | Exit | P&L |
|----------|------|--------|------|-------|------|-----|
| Topstep | `Date` | `Symbol` | `Side` | `EntryPrice` | `ExitPrice` | `PnL` |
| Lucid | `TradeDate` | `Instrument` | `Direction` | `EntryFill` | `ExitFill` | `NetPnL` |
| Generic | `DateTime` | `Ticker` | `Type` | `Entry` | `Exit` | `Profit` |

If your CSV uses different column names, open an issue or rename the headers before importing.

---

## Data Storage

All trades and notes are stored in your **browser's localStorage** — nothing is sent to any server. Clearing browser data will clear your journal. To back up, export your CSV before clearing.

---

## File Structure

```
trade-journal/
├── index.html          # Main app
├── css/
│   └── style.css       # All styles
├── js/
│   └── app.js          # App logic (import, charts, filters)
├── data/
│   └── sample.csv      # Sample trades for testing
└── README.md
```
