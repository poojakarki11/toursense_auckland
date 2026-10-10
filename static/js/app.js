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
const shapCache = {}; // placeId -> Promise of SHAP data (only successful results are kept)
let markerById = {};

// Zoom level at which the map switches from suburb polygons to individual place pins.
// Below this = suburbs (zoomed out); at or above = places (zoomed in).
const ZOOM_SWITCH = 13;

// How long to wait for an explanation before showing a fallback message (ms)
const SHAP_TIMEOUT_MS = 15000;

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

function aspectIcon(data) {
  return data.score === 1 ? "🟢" : data.score === -1 ? "🔴" : "⚪";
}

function shapBody(data, shapForAspect) {
  if (data.score === 0) {
    return `<p class="no-data" style="margin:2px 0">Mixed or neutral mentions – no single word stands out</p>`;
  }
  if (!shapForAspect) {
    return `<p class="no-data" style="margin:2px 0">Not enough mentions to explain</p>`;
  }

  const snippet =
    data.score === 1 ? shapForAspect.positive_snippet :
    data.score === -1 ? shapForAspect.negative_snippet : null;

  if (snippet) {
    const colour = data.score === 1 ? "#c8f2c2" : "#f8c4c4";
    const text = snippet.text.replace(
      "<mark>",
      `<mark style="background:${colour};padding:0 2px;border-radius:3px">`
    );
    return `<p class="shap-snippet" style="font-style:italic;margin:2px 0">"${text}"</p>`;
  }

  return `<p class="no-data" style="margin:2px 0">Not enough mentions to explain</p>`;
}

function buildPopupSkeleton(place) {
  let html = `<div class="popup-card" data-place-id="${place.place_id}">`;
  html += `<h3>${place.name}</h3>`;
  html += `<p class="popup-category">${categoryLabel(place.category)}</p>`;
  html += `<div class="aspect-list">`;

  const mentionedAspects = Object.entries(place.aspects).filter(
    ([_, data]) => data.label !== "not mentioned"
  );

  if (mentionedAspects.length === 0) {
    html += `<p class="no-data" style="margin:2px 0">No aspect data available yet.</p>`;
  } else {
    mentionedAspects.forEach(([aspect, data]) => {
      html += `
        <div class="aspect-row" data-aspect="${aspect}">
          <span>${aspectIcon(data)} ${aspectLabel(aspect)}</span>
          <p class="loading-shap">Loading explanation...</p>
        </div>
      `;
    });
  }

  html += `</div></div>`;
  return html;
}

// Fetch SHAP data for a place, with a timeout.
// Failures are NOT cached, so the next click tries again instead of being stuck.
function fetchShap(placeId) {
  if (shapCache[placeId]) return shapCache[placeId];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_TIMEOUT_MS);

  const request = fetch(`/api/places/${placeId}/shap`, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`SHAP request failed: ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      delete shapCache[placeId]; // allow a retry next time
      throw err;
    })
    .finally(() => clearTimeout(timer));

  shapCache[placeId] = request;
  return request;
}

// Find the popup card inside THIS popup (not any popup on the page)
function waitForCard(popup, tries = 20) {
  return new Promise((resolve) => {
    function check(remaining) {
      const el = popup.getElement();
      const card = el ? el.querySelector(".popup-card") : null;
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
  const card = await waitForCard(e.popup);
  if (!card) return;

  const placeId = card.getAttribute("data-place-id");
  if (!placeId) return; // suburb or other popup without aspect rows

  const place = allPlaces.find((p) => p.place_id === placeId);
  if (!place) return;

  const rows = card.querySelectorAll(".aspect-row");
  if (rows.length === 0) return;

  try {
    const shapData = await fetchShap(placeId);

    rows.forEach((row) => {
      const aspect = row.getAttribute("data-aspect");
      const data = place.aspects[aspect];
      const shapForAspect = shapData[SHAP_ASPECT_KEY[aspect]];
      row.innerHTML = `<span>${aspectIcon(data)} ${aspectLabel(aspect)}</span>${shapBody(data, shapForAspect)}`;
    });

    // Note: intentionally NOT calling e.popup.update() here —
    // Leaflet's Popup.update() resets the popup's innerHTML back to the
    // original bindPopup() string, wiping out the explanations inserted above.
  } catch (err) {
    console.error("SHAP popup update failed:", err);
    const message =
      err.name === "AbortError"
        ? "Explanation is taking too long – close and reopen to try again."
        : "Explanation unavailable right now – close and reopen to try again.";
    rows.forEach((row) => {
      const aspect = row.getAttribute("data-aspect");
      const data = place.aspects[aspect];
      if (data.score === 0) {
        // Neutral aspects never need SHAP data, so show their normal message
        row.innerHTML = `<span>${aspectIcon(data)} ${aspectLabel(aspect)}</span>${shapBody(data, null)}`;
        return;
      }
      const loading = row.querySelector(".loading-shap");
      if (loading) {
        loading.className = "no-data";
        loading.style.margin = "2px 0";
        loading.textContent = message;
      }
    });
  }
}

map.on("popupopen", onPopupOpen);

function render() {
  const activeCategories = getActiveCategories();

  markerLayer.clearLayers();
  markerById = {};

  allPlaces.forEach((place) => {
    if (!activeCategories.includes(place.category)) return;
    if (place.lat == null || place.lng == null) return;

    const color = SENTIMENT_COLOR[place.overall_sentiment] || SENTIMENT_COLOR.neutral;

    const marker = L.circleMarker([place.lat, place.lng], {
      radius: 9,
      color: color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 1.5,
    })
      .addTo(markerLayer)
      .bindPopup(buildPopupSkeleton(place))
      .bindTooltip(place.name, { direction: "top", offset: [0, -8] });

    // Start loading the explanation as soon as the user hovers, so it is
    // usually ready by the time they click.
    marker.on("mouseover", () => {
      fetchShap(place.place_id).catch(() => {});
    });

    markerById[place.place_id] = marker;
  });
}

document.querySelectorAll(".category-filter").forEach((box) => {
  box.addEventListener("change", render);
});

// --- Suburb polygon layer ---

function suburbTooltip(props) {
  return `<strong>${props.sa2_name}</strong><br>${props.place_count} place${props.place_count === 1 ? "" : "s"} · ${props.review_count} review${props.review_count === 1 ? "" : "s"}<br><em>Click to see places</em>`;
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
            // Zoom into the suburb, and always far enough to switch to place pins
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

// --- Hint shown while zoomed out, so users know how to reach the places ---

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

  // Show the hint only while place pins are hidden
  if (showSuburbs && !zoomHint._map) {
    zoomHint.addTo(map);
  } else if (!showSuburbs && zoomHint._map) {
    zoomHint.remove();
  }
}

map.on("zoomend", updateLayerVisibility);
updateLayerVisibility(); // show the hint straight away on first load

// --- Search bar (autocomplete dropdown) ---

const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

const CATEGORY_LABEL = {
  park: "Park",
  accommodation: "Accommodation",
  restaurant: "Restaurant",
  librarymuseum: "Library & museum",
};

function hideSearchResults() {
  searchResults.innerHTML = "";
  searchResults.style.display = "none";
}

function goToPlace(place) {
  // Close the suggestions first, so they never stay open even if something below fails
  searchInput.value = place.name;
  hideSearchResults();
  searchInput.blur();

  try {
    // Make sure the place's category is switched on, otherwise it has no marker
    const box = document.querySelector(`.category-filter[value="${place.category}"]`);
    if (box && !box.checked) {
      box.checked = true;
      render();
    }

    // Zoom in past the suburb/place switch, then show the place layer
    map.closePopup();
    map.setView([place.lat, place.lng], 17, { animate: false });
    updateLayerVisibility();

    // Open the popup directly on the map at the place's location.
    // This works whether or not the marker is inside a cluster, which is
    // what caused the intermittent Leaflet error with zoomToShowLayer.
    L.popup({ offset: [0, -6] })
      .setLatLng([place.lat, place.lng])
      .setContent(buildPopupSkeleton(place))
      .openOn(map);
  } catch (err) {
    console.error("Search selection failed:", err);
  }
}

function showSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    hideSearchResults();
    return;
  }

  const matches = allPlaces
    .filter((p) => p.lat != null && p.lng != null && p.name.toLowerCase().includes(q))
    .slice(0, 8);

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
      catEl.textContent = CATEGORY_LABEL[place.category] || place.category;

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
    const q = searchInput.value.trim().toLowerCase();
    const first = allPlaces.find(
      (p) => p.lat != null && p.lng != null && q.length >= 2 && p.name.toLowerCase().includes(q)
    );
    if (first) goToPlace(first);
  }
});

document.addEventListener("click", (e) => {
  if (!document.getElementById("search-box").contains(e.target)) hideSearchResults();
});

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