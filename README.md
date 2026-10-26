# TourSense Auckland

TourSense is an interactive map that shows how visitors feel about places around Auckland, New Zealand. It applies aspect-based sentiment analysis (ABSA) to Google reviews. Instead of giving each place a single "good or bad" score, it breaks sentiment down into five aspects: **Service**, **Price & Value**, **Facilities & Access**, **Environment** and **Product Quality**. SHAP explanations show which words in real reviews drove each result.

**Live site:** https://nzsentiment.online

---

## How it works

All machine learning runs offline in the `pipeline/` notebooks. The results are stored in a PostgreSQL database, and the website only reads those finished results. No model runs when someone opens the map.

```
Google Places API reviews
        │
        ▼
Data cleaning  ──►  Manual aspect labelling (train ~1,000 / test 160)
        │
        ▼
Baselines (star rating, VADER, TF-IDF + Logistic Regression, zero-shot DeBERTa)
        │
        ▼
Fine-tuned DeBERTa (shared encoder + 5 aspect heads, focal loss)
        │
        ▼
SHAP explainability (word-level contributions per aspect)
        │
        ▼
PostgreSQL + PostGIS (absa_auckland)
        │
        ▼
Flask API  ──►  Leaflet.js map (nzsentiment.online)
```

---

## Dataset

- **Source:** Google Places API
- **Size:** about 2,522 cleaned reviews across 549 places in Auckland
- **Categories:** Restaurants, Accommodation, Parks, Libraries & Museums
- **Labels:** each review is scored per aspect as `-1` (negative), `0` (not mentioned), or `1` (positive)
- **Labelled sets:** about 1,000 training reviews and a 160-review gold test set (40 per category)

Raw review text is not included in this repository, in line with the Google Maps Platform terms of service.

---

## Results

### Track A: whole-review sentiment

| Baseline | Macro-F1 |
|---|---|
| B1: Star rating label | 0.77 |
| B2: VADER | 0.51 |
| B3: TF-IDF + Logistic Regression | 0.60 |

### Track B: aspect-level sentiment (160-review gold test set)

| Aspect | B4: Zero-shot DeBERTa | Fine-tuned DeBERTa (final) |
|---|---|---|
| Service | 0.43 | 0.87 |
| Price & Value | 0.24 | 0.80 |
| Facilities & Access | 0.32 | 0.75 |
| Environment | 0.42 | 0.81 |
| Product Quality | 0.57 | 0.64 |
| **Average macro-F1** | **0.40** | **0.78** |

The zero-shot baseline is `yangheng/deberta-v3-base-absa-v1.1`. The final model fine-tunes DeBERTa with a shared encoder, five aspect-specific classification heads and focal loss to handle class imbalance.

Track A and Track B are measured at different levels (whole review vs. per aspect), so their scores are not directly comparable.

---

## Tech stack

- **Modelling:** Python, pandas, scikit-learn, VADER, Hugging Face Transformers, PyTorch, SHAP
- **Database:** PostgreSQL with PostGIS (suburb polygons)
- **Backend:** Flask, served by Gunicorn behind Nginx (HTTPS via Certbot)
- **Frontend:** Leaflet.js, marker clustering, suburb layer, search, category filters
- **Hosting:** AWS EC2

---

## Repository structure

```
toursense_auckland/
├── app.py                 Flask app and API routes
├── shap_utils.py          SHAP word filtering and snippet helpers
├── static/                JavaScript, CSS, icons
├── templates/             HTML templates
├── requirements.txt       Python dependencies for the web app
├── pipeline/              Data and modelling notebooks, in run order
├── data/                  Labelled training and test sets
└── database/
    └── schema.sql         Table structure for absa_auckland
```

---

## API endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/places` | All places with overall and per-aspect sentiment |
| `GET /api/suburbs` | GeoJSON of suburb polygons with aggregated sentiment |
| `GET /api/places/<place_id>/shap` | Review snippets explaining each aspect for one place |

A place's overall sentiment is labelled positive above `0.15`, negative below `-0.15`, and neutral otherwise.

---

## Running the website locally

1. Clone the repo and create a virtual environment:
   ```bash
   git clone https://github.com/poojakarki11/toursense_auckland.git
   cd toursense_auckland
   python -m venv venv
   source venv/bin/activate        # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```
2. Set up a local PostgreSQL database with PostGIS and create the tables from `database/schema.sql`.
3. Create a `.env` file in the project root with your database connection details:
   ```
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=absa_auckland
   DB_USER=your_user
   DB_PASSWORD=your_password
   ```
4. Run the app:
   ```bash
   flask --app app run
   ```
   Then open http://127.0.0.1:5000.

The `.env` file is excluded from Git and must never be committed.

---

## Reproducing the pipeline

Run the notebooks in `pipeline/` in numbered order. Step 01 needs your own Google Places API key.

The trained model weights are too large for GitHub and are not included in this repository.

---

## Limitations

- Product Quality is the weakest aspect (macro-F1 0.64), and some phrases are assigned to a neighbouring aspect.
- SHAP explanations highlight the single strongest word per aspect, which is not always how a person would explain a rating.
- Places with few reviews mentioning an aspect show "Not enough mentions to explain" rather than a weak result.

---

## Team

| Name | Role |
|---|---|
| Pooja Karki Gnawali | Dashboard, frontend, web app deployment |
| Gary | Fine-tuned model, SHAP, database, server infrastructure |
| Eka | Data cleaning, baselines |
| Ishraka | Explainability and notebook integration |

**Supervisor:** A/Prof Anuradha Mathrani

Massey University, 158.888 Information Technology Project, 2026
