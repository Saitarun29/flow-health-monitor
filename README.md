# Flow Health Monitor

> Catch silent, failing and slow n8n workflows before your clients do.

**Live demo:** https://flow-health-monitor.vercel.app

A health dashboard for n8n workflows across client instances. It flags flows that stopped running, flows that keep failing, and flows that got slow, then explains each incident in plain English and previews the Slack alert.

## What's inside

- `index.html`, `assets/` – the dashboard (runs on sample data in demo mode)
- `api/scan.js` – scans workflow executions and scores each flow's health
- `api/explain.js` – turns an incident into a short plain-English summary
- `lib/` – health rules, sample data, demo explainer
- `n8n/flow-health-monitor.n8n.json` – importable n8n workflow that runs the checks on a schedule and posts to Slack

## Run it locally

```bash
npm i -g vercel
vercel dev
```

No env vars needed for demo mode.

## Deploy

Push to `main` and Vercel deploys it.

---

Built by Sai Tarun · [saitarun.com](https://saitarun.com) · [X](https://x.com/SaiTarunRonanki) · [LinkedIn](https://linkedin.com/in/ronanki-sai-tarun)
