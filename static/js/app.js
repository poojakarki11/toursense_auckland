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
let markerLayer = L.layerGroup().addTo(map);
const shapCache = {};

function getActiveCategories() {
  const checked = document.querySelectorAll(".category-filter:checked");
  return Array.from(checked).map((box) => box.value);
}

const SENTIMENT_COLOR = {
  positive: "#1D9E75",
  neutral: "#BA7517",
  negative: "#E24B4A",
};

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

function waitForCard(popupEl, tries = 10) {
  return new Promise((resolve) => {
    function check(remaining) {
      const card = popupEl ? popupEl.querySelector(".popup-card") : null;
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
  const popupEl = e.popup.getElement();
  const card = await waitForCard(popupEl);
  if (!card) return;
  const placeId = card.getAttribute("data-place-id");
  const place = allPlaces.find((p) => p.place_id === placeId);
  if (!place) return;

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

  e.popup.update();
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

fetch("/api/places")
  .then((response) => response.json())
  .then((places) => {
    allPlaces = places;
    render();
  });