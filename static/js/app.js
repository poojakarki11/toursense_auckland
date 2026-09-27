const map = L.map("map", { zoomControl: false }).setView([-36.8485, 174.7633], 12);
L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

let allPlaces = [];
let markerLayer = L.markerClusterGroup({
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true,
}); // NOT added to map yet — visibility controlled by zoom
let suburbGeoLayer = null;
const shapCache = {};

// Zoom level at which the map switches from suburb polygons to individual place pins.
// Below this = suburbs (zoomed out); at or above = places (zoomed in).
const ZOOM_SWITCH = 13;

function getActiveCategories() {
  const checked = document.querySelectorAll(".category-filter:checked");
  return Array.from(checked).map((box) => box.value);
}

const SENTIMENT_COLOR = {
  positive: "#1D9E75",
  neutral: "#948C7F",
  negative: "#E24B4A",
};

const POS_THRESHOLD = 0.15;
const NEG_THRESHOLD = -0.15;

function sentimentColorFromValue(value) {
  if (value === null || value === undefined) return SENTIMENT_COLOR.neutral;
  const v = parseFloat(value);
  if (v > POS_THRESHOLD) return SENTIMENT_COLOR.positive;
  if (v < NEG_THRESHOLD) return SENTIMENT_COLOR.negative;
  return SENTIMENT_COLOR.neutral;
}

// reviews/place_sentiment use "facilities_access", the SHAP table uses "facilities"
const SHAP_ASPECT_KEY = {
  service: "service",
  price_value: "price_value",
  facilities_access: "facilities",
  environment: "environment",
  product_quality: "product_quality",
};

function tagList(words, kind) {
  if (!words || words.length === 0) return "";
  const cls = kind === "positive" ? "tag tag-positive" : "tag tag-negative";
  return words.map((w) => `<span class="${cls}">${w}</span>`).join(" ");
}

function buildAspectRow(aspectKey, data, shapForAspect) {
  const icon = data.score === 1 ? "🟢" : data.score === -1 ? "🔴" : "⚪";
  let body = "";

  if (shapForAspect && (shapForAspect.positive || shapForAspect.negative)) {
    body += `<div class="shap-tags">`;
    if (shapForAspect.positive) body += tagList(shapForAspect.positive, "positive");
    if (shapForAspect.negative) body += tagList(shapForAspect.negative, "negative");
    body += `</div>`;
  } else {
    body = `<p class="no-data">Not enough mentions to explain</p>`;
  }

  return `
    <div class="aspect-row">
      <span>${icon} ${aspectKey.replace("_", " ")}</span>
      ${body}
    </div>
  `;
}

function buildPopupSkeleton(place) {
  let html = `<div class="popup-card" data-place-id="${place.place_id}">`;
  html += `<h3>${place.name}</h3>`;
  html += `<p class="popup-category">${place.category}</p>`;
  html += `<div class="aspect-list">`;

  const mentionedAspects = Object.entries(place.aspects).filter(
    ([_, data]) => data.label !== "not mentioned"
  );

  if (mentionedAspects.length === 0) {
    html += `<p class="no-data">No aspect data available yet.</p>`;
  } else {
    mentionedAspects.forEach(([aspect, data]) => {
      const icon = data.score === 1 ? "🟢" : data.score === -1 ? "🔴" : "⚪";
      html += `
        <div class="aspect-row" data-aspect="${aspect}">
          <span>${icon} ${aspect.replace("_", " ")}</span>
          <p class="loading-shap">Loading explanation...</p>
        </div>
      `;
    });
  }

  html += `</div></div>`;
  return html;
}

async function fetchShap(placeId) {
  if (shapCache[placeId]) return shapCache[placeId];
  const res = await fetch(`/api/places/${placeId}/shap`);
  if (!res.ok) {
    shapCache[placeId] = {};
    return {};
  }
  const data = await res.json();
  shapCache[placeId] = data;
  return data;
}

function waitForCard(tries = 20) {
  return new Promise((resolve) => {
    function check(remaining) {
      const card = document.querySelector(".leaflet-popup .popup-card");
      if (card || remaining <= 0) {
        resolve(card);
      } else {
        requestAnimationFrame(() => check(remaining - 1));
      }
    }
    check(tries);
  });
}

async function onPopupOpen(e) {
  try {
    const card = await waitForCard();
    if (!card) {
      console.warn("SHAP popup: card never appeared");
      return;
    }
    const placeId = card.getAttribute("data-place-id");
    const place = allPlaces.find((p) => p.place_id === placeId);
    if (!place) {
      // Not every popup belongs to a place (suburb popups don't have aspect rows), so this is normal.
      return;
    }

    const shapData = await fetchShap(placeId);

    card.querySelectorAll(".aspect-row").forEach((row) => {
      const aspect = row.getAttribute("data-aspect");
      const data = place.aspects[aspect];
      const shapKey = SHAP_ASPECT_KEY[aspect];
      const shapForAspect = shapData[shapKey];

      const icon = data.score === 1 ? "🟢" : data.score === -1 ? "🔴" : "⚪";
      let body = "";
      if (shapForAspect && (shapForAspect.positive || shapForAspect.negative)) {
        body += `<div class="shap-tags">`;
        if (shapForAspect.positive) body += tagList(shapForAspect.positive, "positive");
        if (shapForAspect.negative) body += tagList(shapForAspect.negative, "negative");
        body += `</div>`;
      } else {
        body = `<p class="no-data">Not enough mentions to explain</p>`;
      }

      row.innerHTML = `<span>${icon} ${aspect.replace("_", " ")}</span>${body}`;
    });

    // Note: intentionally NOT calling e.popup.update() here —
    // Leaflet's Popup.update() calls _updateContent(), which resets
    // the popup's innerHTML back to its original bindPopup() string,
    // wiping out the SHAP tags we just inserted above.
  } catch (err) {
    console.error("SHAP popup update failed:", err);
  }
}

map.on("popupopen", onPopupOpen);

function render() {
  const activeCategories = getActiveCategories();

  markerLayer.clearLayers();

  allPlaces.forEach((place) => {
    if (!activeCategories.includes(place.category)) return;
    if (place.lat == null || place.lng == null) return;

    const color = SENTIMENT_COLOR[place.overall_sentiment];

    L.circleMarker([place.lat, place.lng], {
      radius: 9,
      color: color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 1.5,
    })
      .addTo(markerLayer)
      .bindPopup(buildPopupSkeleton(place));
  });
}

document.querySelectorAll(".category-filter").forEach((box) => {
  box.addEventListener("change", render);
});

// --- Suburb polygon layer ---

function buildSuburbPopup(props) {
  return `
    <div class="popup-card">
      <h3>${props.sa2_name}</h3>
      <p class="popup-category">${props.place_count} place${props.place_count === 1 ? "" : "s"} · ${props.review_count} review${props.review_count === 1 ? "" : "s"}</p>
    </div>
  `;
}

function loadSuburbs() {
  fetch("/api/suburbs")
    .then((res) => res.json())
    .then((geojson) => {
      suburbGeoLayer = L.geoJSON(geojson, {
        style: (feature) => ({
          fillColor: sentimentColorFromValue(feature.properties.overall_sentiment),
          fillOpacity: 0.55,
          color: "#ffffff",
          weight: 1,
        }),
        onEachFeature: (feature, layer) => {
          layer.bindPopup(buildSuburbPopup(feature.properties));
          layer.on("click", () => {
            map.fitBounds(layer.getBounds());
          });
          layer.on("mouseover", () => layer.setStyle({ fillOpacity: 0.75 }));
          layer.on("mouseout", () => layer.setStyle({ fillOpacity: 0.55 }));
        },
      });
      updateLayerVisibility();
    })
    .catch((err) => console.error("Failed to load suburbs:", err));
}

function updateLayerVisibility() {
  const zoom = map.getZoom();
  const showSuburbs = zoom < ZOOM_SWITCH;

  if (suburbGeoLayer) {
    if (showSuburbs && !map.hasLayer(suburbGeoLayer)) {
      map.addLayer(suburbGeoLayer);
    } else if (!showSuburbs && map.hasLayer(suburbGeoLayer)) {
      map.removeLayer(suburbGeoLayer);
    }
  }

  if (showSuburbs && map.hasLayer(markerLayer)) {
    map.removeLayer(markerLayer);
  } else if (!showSuburbs && !map.hasLayer(markerLayer)) {
    map.addLayer(markerLayer);
  }
}

map.on("zoomend", updateLayerVisibility);

fetch("/api/places")
  .then((response) => response.json())
  .then((places) => {
    allPlaces = places;
    render();
    updateLayerVisibility();
  });

loadSuburbs();