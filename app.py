from flask import Flask, render_template, jsonify
import psycopg2
import psycopg2.extras
import os
from dotenv import load_dotenv
from collections import defaultdict

load_dotenv()

app = Flask(__name__)

POS_THRESHOLD = 0.15
NEG_THRESHOLD = -0.15

ASPECT_COLUMNS = ["service", "price_value", "facilities_access", "environment", "product_quality"]

def get_db_connection():
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD")
    )
    return conn

def sentiment_label(value):
    if value is None:
        return "neutral"
    value = float(value)
    if value > POS_THRESHOLD:
        return "positive"
    if value < NEG_THRESHOLD:
        return "negative"
    return "neutral"

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/places")
def api_places():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT p.place_id, p.place_name, p.category, p.address,
               p.latitude, p.longitude, p.google_rating, p.total_reviews,
               ps.overall_sentiment
        FROM places p
        LEFT JOIN place_sentiment ps ON p.place_id = ps.place_id;
    """)
    place_rows = cur.fetchall()

    cur.execute("""
        SELECT place_id, review_text, review_rating, word_count,
               service, price_value, facilities_access, environment, product_quality
        FROM reviews;
    """)
    review_rows = cur.fetchall()

    cur.close()
    conn.close()

    reviews_by_place = defaultdict(list)
    for r in review_rows:
        reviews_by_place[r["place_id"]].append(r)

    places_out = []
    for place in place_rows:
        place_reviews = reviews_by_place.get(place["place_id"], [])
        aspects = {}

        for aspect in ASPECT_COLUMNS:
            mentioned = [r for r in place_reviews if r[aspect] != 0]
            if not mentioned:
                aspects[aspect] = {"label": "not mentioned", "score": 0, "snippet": None}
                continue

            avg_val = sum(r[aspect] for r in mentioned) / len(mentioned)
            label = sentiment_label(avg_val)
            score = 1 if avg_val > 0 else (-1 if avg_val < 0 else 0)

            matching_sign = [r for r in mentioned if (r[aspect] > 0) == (avg_val > 0)]
            candidates = matching_sign if matching_sign else mentioned
            best = max(candidates, key=lambda r: (r["word_count"] or 0))
            snippet = best["review_text"]

            aspects[aspect] = {"label": label, "score": score, "snippet": snippet}

        places_out.append({
            "place_id": place["place_id"],
            "name": place["place_name"],
            "category": place["category"],
            "address": place["address"],
            "lat": float(place["latitude"]) if place["latitude"] is not None else None,
            "lng": float(place["longitude"]) if place["longitude"] is not None else None,
            "google_rating": float(place["google_rating"]) if place["google_rating"] is not None else None,
            "total_reviews": place["total_reviews"],
            "overall_sentiment": sentiment_label(place["overall_sentiment"]),
            "aspects": aspects
        })

    return jsonify(places_out)

@app.route("/api/suburbs")
def api_suburbs():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', jsonb_agg(feature)
        )
        FROM (
            SELECT jsonb_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(s.geom)::jsonb,
                'properties', jsonb_build_object(
                    'suburb_id', s.suburb_id,
                    'sa2_name', s.sa2_name,
                    'overall_sentiment', ss.overall_sentiment,
                    'place_count', ss.place_count,
                    'review_count', ss.review_count,
                    'service_mean', ss.service_mean,
                    'price_value_mean', ss.price_value_mean,
                    'facilities_access_mean', ss.facilities_access_mean,
                    'environment_mean', ss.environment_mean,
                    'product_quality_mean', ss.product_quality_mean
                )
            ) AS feature
            FROM suburbs s
            JOIN suburb_sentiment ss ON s.suburb_id = ss.suburb_id
        ) sub;
    """)
    result = cur.fetchone()[0]
    cur.close()
    conn.close()
    return jsonify(result)

@app.route("/api/places/<place_id>/shap")
def api_place_shap(place_id):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT service_pos, service_neg, price_value_pos, price_value_neg,
               facilities_pos, facilities_neg, environment_pos, environment_neg,
               product_quality_pos, product_quality_neg
        FROM place_shap
        WHERE place_id = %s;
    """, (place_id,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        return jsonify({}), 404

    def top3(words):
        if not words:
            return []
        sorted_words = sorted(words, key=lambda w: w.get("score", 0), reverse=True)
        return [w["word"] for w in sorted_words[:3]]

    aspects = ["service", "price_value", "facilities", "environment", "product_quality"]
    result = {}
    for aspect in aspects:
        pos_words = top3(row.get(f"{aspect}_pos"))
        neg_words = top3(row.get(f"{aspect}_neg"))
        result[aspect] = {
            "positive": pos_words if pos_words else None,
            "negative": neg_words if neg_words else None
        }
    return jsonify(result)

if __name__ == "__main__":
    app.run(debug=True)