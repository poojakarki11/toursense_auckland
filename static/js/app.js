const map = L.map("map").setView([-36.8485, 174.7633], 12);

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

function getActiveCategories() {
  const checked = document.querySelectorAll(".category-filter:checked");
  return Array.from(checked).map((box) => box.value);
}

const SENTIMENT_COLOR = {
  positive: "#1D9E75",
  neutral: "#BA7517",
  negative: "#E24B4A",
};

function buildPopupContent(place) {
  let html = `<div class="popup-card">`;
  html += `<h3>${place.name}</h3>`;
  html += `<p class="popup-category">${place.category}</p>`;
  html += `<div class="aspect-list">`;

  for (const [aspect, data] of Object.entries(place.aspects)) {
    if (data.label === "not mentioned") continue;

    const icon = data.score === 1 ? "🟢" : data.score === -1 ? "🔴" : "⚪";
    html += `
      <div class="aspect-row">
        <span>${icon} ${aspect.replace("_", " ")}</span>
        ${data.snippet ? `<p class="snippet">"${data.snippet}"</p>` : ""}
      </div>
    `;
  }

  html += `</div></div>`;
  return html;
}

function render() {
  const activeCategories = getActiveCategories();

  markerLayer.clearLayers();

  allPlaces.forEach((place) => {
    if (!activeCategories.includes(place.category)) return;

    const color = SENTIMENT_COLOR[place.overall_sentiment];

    L.circleMarker([place.lat, place.lng], {
      radius: 9,
      color: color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 1.5,
    })
      .addTo(markerLayer)
      .bindPopup(buildPopupContent(place));
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