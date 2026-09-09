from flask import Flask, render_template, jsonify
import json

app = Flask(__name__)

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/places")
def api_places():
    with open("static/data/places.json") as f:
        places = json.load(f)
    return jsonify(places)

if __name__ == "__main__":
    app.run(debug=True, port=5000)