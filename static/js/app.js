const map = L.map("map", { zoomControl: false }).setView([-36.8485, 174.7633], 12);
L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let allPlaces = [];
let markerLayer = L.markerClusterGroup({
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true,
}); // NOT added to map yet — visibility controlled by zoom
let suburbGeoLayer = null;
const shapCache = {}; // placeId -> Promise of SHAP data (only successful results are kept)
let markerById = {};
let selectedPlaceId = null;

// Zoom level at which the map switches from suburb polygons to individual place pins.
// Below this = suburbs (zoomed out); at or above = places (zoomed in).
const ZOOM_SWITCH = 13;

// How long to wait for an explanation before showing a fallback message (ms)
const SHAP_TIMEOUT_MS = 15000;

const SENTIMENT_COLOR = {
  positive: "#1D9E75",
  neutral: "#948C7F",
  negative: "#E24B4A",
};

const POS_THRESHOLD = 0.15;
const NEG_THRESHOLD = -0.15;

// reviews/place_sentiment use "facilities_access", the SHAP table uses "facilities"
const SHAP_ASPECT_KEY = {
  service: "service",
  price_value: "price_value",
  facilities_access: "facilities",
  environment: "environment",
  product_quality: "product_quality",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function sentimentColorFromValue(value) {
  if (value === null || value === undefined) return SENTIMENT_COLOR.neutral;
  const v = parseFloat(value);
  if (v > POS_THRESHOLD) return SENTIMENT_COLOR.positive;
  if (v < NEG_THRESHOLD) return SENTIMENT_COLOR.negative;
  return SENTIMENT_COLOR.neutral;
}

function scoreToSentiment(score) {
  return score === 1 ? "positive" : score === -1 ? "negative" : "neutral";
}

function sentimentBadge(sentiment) {
  const s = SENTIMENT_COLOR[sentiment] ? sentiment : "neutral";
  const label = s.charAt(0).toUpperCase() + s.slice(1);
  return `<span class="badge ${s}">${label}</span>`;
}

// No category chip selected = "All places". Otherwise show only the selected categories.
function getActiveCategories() {
  const all = Array.from(document.querySelectorAll(".category-filter")).map((b) => b.value);
  const checked = Array.from(document.querySelectorAll(".category-filter:checked")).map((b) => b.value);
  return checked.length === 0 ? all : checked;
}

function aspectLabel(key) {
  const labels = {
    service: "Service",
    price_value: "Price & Value",
    facilities_access: "Facilities & Access",
    environment: "Environment",
    product_quality: "Product Quality",
  };
  return labels[key] || key;
}

function categoryLabel(cat) {
  const labels = {
    park: "Park",
    accommodation: "Accommodation",
    restaurant: "Restaurant",
    librarymuseum: "Library & Museum",
  };
  const k = (cat || "").toLowerCase().replace(/[^a-z]/g, "");
  return labels[k] || cat;
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

const panel = document.getElementById("place-panel");
const panelContent = document.getElementById("panel-content");
const isSmallScreen = () => window.matchMedia("(max-width: 760px)").matches;

function showPanel() {
  const wasHidden = panel.classList.contains("hidden");
  panel.classList.remove("hidden");
  if (wasHidden) map.invalidateSize();
}

function hidePanel() {
  panel.classList.add("hidden");
  map.invalidateSize();
}

function showIntro() {
  clearSelection();
  panelContent.innerHTML = `
    <div class="intro">
      <h2>Explore what visitors say</h2>
      <p>This map shows how visitors feel about Auckland places, based on Google reviews,
         across five aspects: Service, Price &amp; Value, Facilities &amp; Access,
         Environment and Product Quality.</p>
      <ul>
        <li><strong>Zoomed out:</strong> suburbs are coloured by overall sentiment. Click a suburb to zoom in.</li>
        <li><strong>Zoomed in:</strong> each dot is a place. Click it to see its aspects here.</li>
        <li>Use the category buttons above to show only Parks, Restaurants and so on (pick one or more), or search for a place by name.</li>
      </ul>
      <p>For each aspect we show a short review excerpt. The highlighted word is the one
         the model relied on most for that aspect (SHAP explanation), for example:</p>
      <div class="example">"...the staff were <mark>friendly</mark> and helpful..."</div>
      <p class="panel-note">Explanations show what the model relied on, not a human judgement,
         and some aspects have too few reviews to explain.</p>
    </div>
  `;
  showPanel();
}

// Build the panel for one place. Explanations are filled in afterwards.
function buildPlacePanel(place) {
  const entries = Object.entries(place.aspects || {});
  const mentioned = entries.filter(([_, d]) => d.label !== "not mentioned");
  const notMentioned = entries.filter(([_, d]) => d.label === "not mentioned");

  let html = `
    <h2 class="panel-title">${escapeHtml(place.name)}</h2>
    <p class="panel-meta">
      <span>${escapeHtml(categoryLabel(place.category))}</span>
      <span aria-hidden="true">·</span>
      <span>Overall</span> ${sentimentBadge(place.overall_sentiment)}
    </p>
  `;

  if (mentioned.length === 0) {
    html += `<p class="no-data">No aspect data available yet.</p>`;
  } else {
    mentioned.forEach(([aspect, data]) => {
      html += `
        <div class="aspect-card ${scoreToSentiment(data.score)}" data-aspect="${aspect}">
          <div class="aspect-head">
            <span class="aspect-name">${aspectLabel(aspect)}</span>
            ${sentimentBadge(scoreToSentiment(data.score))}
          </div>
          <div class="aspect-body"><p class="loading-shap">Loading explanation...</p></div>
        </div>
      `;
    });
  }

  if (notMentioned.length > 0) {
    const names = notMentioned.map(([a]) => aspectLabel(a)).join(", ");
    html += `<p class="not-mentioned">Not mentioned in reviews: ${names}</p>`;
  }

  html += `<p class="panel-note">Highlighted words show what the model relied on most for each aspect.</p>`;
  return html;
}

function explanationHtml(data, shapForAspect) {
  if (data.score === 0) {
    return `<p class="no-data">Mixed or neutral mentions – no single word stands out</p>`;
  }
  const snippet = !shapForAspect ? null :
    data.score === 1 ? shapForAspect.positive_snippet :
    data.score === -1 ? shapForAspect.negative_snippet : null;

  if (snippet && snippet.text) {
    const cls = data.score === 1 ? "positive" : "negative";
    return `<p class="shap-snippet ${cls}">"${snippet.text}"</p>`;
  }
  return `<p class="no-data">Not enough mentions to explain</p>`;
}

// Fetch SHAP data for a place, with a timeout.
// Failures are NOT cached, so the next try asks the server again.
function fetchShap(placeId) {
  if (shapCache[placeId]) return shapCache[placeId];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_TIMEOUT_MS);

  const request = fetch(`/api/places/${encodeURIComponent(placeId)}/shap`, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`SHAP request failed: ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      delete shapCache[placeId];
      throw err;
    })
    .finally(() => clearTimeout(timer));

  shapCache[placeId] = request;
  return request;
}

async function fillExplanations(place) {
  const cards = panelContent.querySelectorAll(".aspect-card");
  if (cards.length === 0) return;

  try {
    const shapData = await fetchShap(place.place_id);
    if (selectedPlaceId !== place.place_id) return; // user picked another place meanwhile

    cards.forEach((card) => {
      const aspect = card.getAttribute("data-aspect");
      const data = place.aspects[aspect];
      card.querySelector(".aspect-body").innerHTML =
        explanationHtml(data, shapData[SHAP_ASPECT_KEY[aspect]]);
    });
  } catch (err) {
    console.error("Explanation load failed:", err);
    if (selectedPlaceId !== place.place_id) return;

    const message = err.name === "AbortError"
      ? "Explanation is taking too long."
      : "Explanation unavailable right now.";

    cards.forEach((card) => {
      const aspect = card.getAttribute("data-aspect");
      const data = place.aspects[aspect];
      const body = card.querySelector(".aspect-body");
      if (data.score === 0) {
        body.innerHTML = explanationHtml(data, null);
      } else {
        body.innerHTML = `<p class="no-data">${message} <a href="#" class="retry-link">Try again</a></p>`;
      }
    });
    panelContent.querySelectorAll(".retry-link").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        selectPlace(place, { moveMap: false });
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Selecting a place (from a marker click or from search)
// ---------------------------------------------------------------------------

function markerStyle(place, selected) {
  const color = SENTIMENT_COLOR[place.overall_sentiment] || SENTIMENT_COLOR.neutral;
  return selected
    ? { radius: 12, color: "#1f2933", weight: 3, fillColor: color, fillOpacity: 1 }
    : { radius: 9, color: color, weight: 1.5, fillColor: color, fillOpacity: 0.85 };
}

function clearSelection() {
  if (selectedPlaceId && markerById[selectedPlaceId]) {
    const prev = allPlaces.find((p) => p.place_id === selectedPlaceId);
    if (prev) markerById[selectedPlaceId].setStyle(markerStyle(prev, false));
  }
  selectedPlaceId = null;
}

function selectPlace(place, { moveMap = true } = {}) {
  clearSelection();
  selectedPlaceId = place.place_id;

  panelContent.innerHTML = buildPlacePanel(place);
  panel.scrollTop = 0;
  showPanel();

  const marker = markerById[place.place_id];
  if (marker) {
    marker.setStyle(markerStyle(place, true));
    if (marker.bringToFront) marker.bringToFront();
  }

  if (moveMap) {
    const zoom = Math.max(map.getZoom(), 16);
    map.setView([place.lat, place.lng], zoom, { animate: false });
    updateLayerVisibility();
  }

  fillExplanations(place);
}

// Close: from a place -> back to the intro (desktop); from the intro -> hide the panel.
// "About" in the top bar always brings the intro back.
document.getElementById("panel-close").addEventListener("click", () => {
  const wasPlace = selectedPlaceId !== null;
  clearSelection();
  if (wasPlace && !isSmallScreen()) {
    showIntro();
  } else {
    hidePanel();
  }
});

document.getElementById("about-btn").addEventListener("click", showIntro);

// ---------------------------------------------------------------------------
// Place markers
// ---------------------------------------------------------------------------

function render() {
  const activeCategories = getActiveCategories();

  markerLayer.clearLayers();
  markerById = {};

  allPlaces.forEach((place) => {
    if (!activeCategories.includes(place.category)) return;
    if (place.lat == null || place.lng == null) return;

    const marker = L.circleMarker([place.lat, place.lng],
      markerStyle(place, place.place_id === selectedPlaceId))
      .addTo(markerLayer)
      .bindTooltip(escapeHtml(place.name), { direction: "top", offset: [0, -8] });

    // Start loading the explanation on hover, so it is usually ready on click
    marker.on("mouseover", () => fetchShap(place.place_id).catch(() => {}));
    marker.on("click", () => selectPlace(place, { moveMap: false }));

    markerById[place.place_id] = marker;
  });
}

function syncChips() {
  let anyChecked = false;
  document.querySelectorAll(".category-filter").forEach((box) => {
    box.closest(".chip").classList.toggle("active", box.checked);
    if (box.checked) anyChecked = true;
  });
  document.getElementById("chip-all").classList.toggle("active", !anyChecked);
}

document.querySelectorAll(".category-filter").forEach((box) => {
  box.addEventListener("change", () => {
    syncChips();
    render();
  });
});

// "All places" clears the category selection
document.getElementById("chip-all").addEventListener("click", () => {
  document.querySelectorAll(".category-filter").forEach((box) => (box.checked = false));
  syncChips();
  render();
});

// ---------------------------------------------------------------------------
// Suburb polygon layer
// ---------------------------------------------------------------------------

function suburbTooltip(props) {
  return `<strong>${escapeHtml(props.sa2_name)}</strong><br>${props.place_count} place${props.place_count === 1 ? "" : "s"} · ${props.review_count} review${props.review_count === 1 ? "" : "s"}<br><em>Click to see places</em>`;
}

function loadSuburbs() {
  fetch("/api/suburbs")
    .then((res) => {
      if (!res.ok) throw new Error(`Suburbs request failed: ${res.status}`);
      return res.json();
    })
    .then((geojson) => {
      suburbGeoLayer = L.geoJSON(geojson, {
        style: (feature) => ({
          fillColor: sentimentColorFromValue(feature.properties.overall_sentiment),
          fillOpacity: 0.55,
          color: "#ffffff",
          weight: 1,
        }),
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(suburbTooltip(feature.properties), { sticky: true });
          layer.on("click", () => {
            const bounds = layer.getBounds();
            const zoom = Math.max(map.getBoundsZoom(bounds), ZOOM_SWITCH);
            map.setView(bounds.getCenter(), zoom);
          });
          layer.on("mouseover", () => layer.setStyle({ fillOpacity: 0.75 }));
          layer.on("mouseout", () => layer.setStyle({ fillOpacity: 0.55 }));
        },
      });
      updateLayerVisibility();
    })
    .catch((err) => console.error("Failed to load suburbs:", err));
}

// ---------------------------------------------------------------------------
// Zoom hint + switching between suburbs and places
// ---------------------------------------------------------------------------

const ZoomHint = L.Control.extend({
  options: { position: "bottomright" },
  onAdd: function () {
    const div = L.DomUtil.create("div", "zoom-hint");
    div.innerHTML = "🔍 Zoom in or click a suburb to see individual places";
    div.style.cssText =
      "background:#ffffff;padding:8px 12px;border-radius:8px;" +
      "box-shadow:0 1px 4px rgba(0,0,0,0.25);font-size:14px;color:#333;";
    return div;
  },
});
const zoomHint = new ZoomHint();

function updateLayerVisibility() {
  const showSuburbs = map.getZoom() < ZOOM_SWITCH;

  if (suburbGeoLayer) {
    if (showSuburbs && !map.hasLayer(suburbGeoLayer)) map.addLayer(suburbGeoLayer);
    else if (!showSuburbs && map.hasLayer(suburbGeoLayer)) map.removeLayer(suburbGeoLayer);
  }

  if (showSuburbs && map.hasLayer(markerLayer)) map.removeLayer(markerLayer);
  else if (!showSuburbs && !map.hasLayer(markerLayer)) map.addLayer(markerLayer);

  if (showSuburbs && !zoomHint._map) zoomHint.addTo(map);
  else if (!showSuburbs && zoomHint._map) zoomHint.remove();
}

map.on("zoomend", updateLayerVisibility);

// ---------------------------------------------------------------------------
// Search bar (autocomplete dropdown)
// ---------------------------------------------------------------------------

const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

function hideSearchResults() {
  searchResults.innerHTML = "";
  searchResults.style.display = "none";
}

function findMatches(query, limit) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return allPlaces
    .filter((p) => p.lat != null && p.lng != null && p.name.toLowerCase().includes(q))
    .slice(0, limit);
}

function goToPlace(place) {
  // Close the suggestions first, so they never stay open even if something below fails
  searchInput.value = place.name;
  hideSearchResults();
  searchInput.blur();

  try {
    // If the place's category is filtered out, switch back to "All places" so it has a marker
    if (!getActiveCategories().includes(place.category)) {
      document.querySelectorAll(".category-filter").forEach((b) => (b.checked = false));
      syncChips();
      render();
    }
    selectPlace(place, { moveMap: true });
  } catch (err) {
    console.error("Search selection failed:", err);
  }
}

function showSearchResults(query) {
  if (query.trim().length < 2) {
    hideSearchResults();
    return;
  }
  const matches = findMatches(query, 8);
  searchResults.innerHTML = "";

  if (matches.length === 0) {
    const li = document.createElement("li");
    li.className = "search-empty";
    li.textContent = "No matching places";
    searchResults.appendChild(li);
  } else {
    matches.forEach((place) => {
      const li = document.createElement("li");
      li.className = "search-item";

      const nameEl = document.createElement("span");
      nameEl.className = "search-name";
      nameEl.textContent = place.name;

      const catEl = document.createElement("span");
      catEl.className = "search-cat";
      catEl.textContent = categoryLabel(place.category);

      li.appendChild(nameEl);
      li.appendChild(catEl);
      // mousedown (not click) so it fires before the input loses focus
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        goToPlace(place);
      });
      searchResults.appendChild(li);
    });
  }
  searchResults.style.display = "block";
}

searchInput.addEventListener("input", () => showSearchResults(searchInput.value));

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideSearchResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const first = findMatches(searchInput.value, 1)[0];
    if (first) goToPlace(first);
  }
});

document.addEventListener("click", (e) => {
  if (!document.getElementById("search-box").contains(e.target)) hideSearchResults();
});

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

if (isSmallScreen()) {
  panel.classList.add("hidden"); // keep the map visible on phones until a place is chosen
} else {
  showIntro();
}
updateLayerVisibility(); // show the zoom hint straight away

fetch("/api/places")
  .then((response) => {
    if (!response.ok) throw new Error(`Places request failed: ${response.status}`);
    return response.json();
  })
  .then((places) => {
    allPlaces = places;
    render();
    updateLayerVisibility();
  })
  .catch((err) => console.error("Failed to load places:", err));

loadSuburbs();