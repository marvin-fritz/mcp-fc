# GeoNews → REST-API-Integration (webapi)

Anleitung, um die vom MCP/Geo-Agenten befüllte Collection `financecentre.newsGeo`
in der FastAPI-webapi (`api.finanz-copilot.de`) bereitzustellen — als Datenquelle
für die MapKit-Karte in der App. Zugeschnitten auf die bestehende Struktur
(Beanie-Models, Service-Layer, `app/api/v1/endpoints/`).

## 1. Datenmodell der Collection

Ein Dokument pro verorteter Nachricht (Upsert per `newsId`, geschrieben vom
MCP-Tool `submit_news_locations`):

| Feld | Typ | Bedeutung |
|---|---|---|
| `newsId` | ObjectId | Referenz auf `news._id` (unique) |
| `locatable` | bool | `false` = News hat keinen sinnvollen Ort (**für die Karte filtern!**) |
| `location` | GeoJSON Point | `{ type: "Point", coordinates: [lon, lat] }` — **Reihenfolge beachten** |
| `country` | str | ISO 3166-1 alpha-2, uppercase (`DE`, `US`) |
| `place` | str? | Anzeigename („Frankfurt am Main"), fehlt bei `precision=country` |
| `precision` | str | `country` \| `region` \| `city` |
| `confidence` | float? | 0–1 — Sicherheit der **Verortung** |
| `relevance` | float | 0–1 — Bedeutung des **Ereignisses** (steuert Pin-Größe & Filter) |
| `summary` | str? | 1–2 Sätze für den Pin-Callout (deutsch) |
| `title`, `sourceName`, `link`, `image`, `pubDate`, `category` | — | denormalisiert aus `news` — **kein Join nötig** |
| `locatedBy`, `locatedAt` | — | Agent-Name + Zeitstempel |

**relevance-Skala** (vom Agenten vergeben, feste Ankerpunkte):

| Wert | Bedeutung | Beispiele |
|---|---|---|
| 0.95–1.0 | historischer Schock | 11. September, Kriegsausbruch, Marktcrash, Bankenkollaps |
| 0.8–0.94 | groß | Notenbank-Überraschung, Eskalation Iran-Konflikt, Mega-Merger |
| 0.6–0.79 | bedeutend | erwarteter Zinsentscheid, Large-Cap-Quartalszahlen, nationale Wahl |
| 0.4–0.59 | mittel | Mid-Cap-News, Branchenberichte |
| 0.2–0.39 | Routine | Small-Cap-PR, Analystenkommentare |
| 0–0.19 | trivial | irrelevantes Rauschen |

Vorhandene Indizes (via mcp-fc `ensure-indexes` angelegt): `{newsId:1}` unique,
`{location:'2dsphere'}` sparse, `{pubDate:-1}`, `{country:1,pubDate:-1}`,
`{relevance:-1,pubDate:-1}`. Viewport- und Top-Stories-Queries laufen also ohne
weitere Vorbereitung über einen Index.

Befüllung: täglich 8:00 Uhr durch den Geo-Agenten (Claude-Scheduled-Task) —
die Daten sind **nicht** realtime; `locatedAt` zeigt die Aktualität.

## 2. Beanie-Model — `app/models/news_geo.py`

```python
"""Beanie Document model for the newsGeo collection (map feature)."""

from datetime import datetime

from beanie import Document, PydanticObjectId
from pydantic import BaseModel


class GeoPoint(BaseModel):
    """GeoJSON Point. coordinates = [longitude, latitude] (WGS84)."""

    type: str = "Point"
    coordinates: list[float]  # [lon, lat]


class NewsGeo(Document):
    """One geolocated news item, written by the mcp-fc geolocation agent."""

    newsId: PydanticObjectId
    locatable: bool = True
    location: GeoPoint | None = None
    country: str | None = None          # ISO 3166-1 alpha-2
    place: str | None = None
    precision: str | None = None        # country | region | city
    confidence: float | None = None     # certainty of the LOCATION
    relevance: float = 0.0              # importance of the EVENT (0-1)
    summary: str | None = None
    # denormalized from news:
    title: str
    sourceName: str
    link: str
    image: str | None = None
    pubDate: datetime
    category: str
    # meta:
    locatedBy: str
    locatedAt: datetime

    class Settings:
        name = "newsGeo"
```

**Wichtig:** `NewsGeo` in die `document_models`-Liste der Beanie-Initialisierung
aufnehmen (dort, wo `News`, `NewsSource` etc. registriert sind — z.B.
`app/core/db.py` / `init_beanie(...)`). Beanie legt keine Indizes an, die
existieren bereits — keine `Indexed`-Annotationen nötig.

## 3. Response-Schema — `app/schemas/news_geo.py`

Für die App flach und MapKit-freundlich (lat/lon getrennt statt GeoJSON):

```python
"""Response schemas for geolocated news."""

from datetime import datetime

from pydantic import BaseModel


class NewsGeoResponse(BaseModel):
    id: str                    # newsGeo._id
    newsId: str                # news._id (für Detail-Navigation)
    lat: float
    lon: float
    country: str
    place: str | None = None
    precision: str
    confidence: float | None = None
    relevance: float           # 0-1 → Pin-Größe/Farbe in der App
    summary: str | None = None
    title: str
    sourceName: str
    link: str
    image: str | None = None
    pubDate: datetime
    category: str


class CountryCount(BaseModel):
    country: str
    count: int
    maxRelevance: float        # wichtigste Story des Landes → Badge-Farbe
    latestPubDate: datetime
```

## 4. Service — `app/services/news_geo.py`

Kernstück ist die Viewport-Query: Die App schickt die sichtbare Kartenregion
als Bounding-Box, Mongo filtert über den 2dsphere-Index mit einem
`$geoWithin`-Polygon (`$box` funktioniert NICHT mit 2dsphere-Indizes).

```python
"""Service for geolocated news (map feature)."""

from datetime import datetime

from app.models.news_geo import NewsGeo


class NewsGeoService:
    """Read-only access to newsGeo. Writes happen via the mcp-fc agent."""

    @staticmethod
    def _bbox_polygon(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> dict:
        """Closed GeoJSON polygon ring for a lat/lon bounding box."""
        return {
            "type": "Polygon",
            "coordinates": [[
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]],
        }

    @staticmethod
    async def get_in_viewport(
        min_lat: float,
        min_lon: float,
        max_lat: float,
        max_lon: float,
        limit: int = 200,
        min_relevance: float = 0.0,
        sort_by: str = "relevance",      # "relevance" | "date"
        category: str | None = None,
        country: str | None = None,
        from_date: datetime | None = None,
        to_date: datetime | None = None,
    ) -> list[NewsGeo]:
        """Located news inside the map viewport, most relevant (or newest) first."""
        query: dict = {
            "locatable": True,
            "location": {
                "$geoWithin": {
                    "$geometry": NewsGeoService._bbox_polygon(min_lat, min_lon, max_lat, max_lon)
                }
            },
        }
        if min_relevance > 0:
            query["relevance"] = {"$gte": min_relevance}
        if category:
            query["category"] = category.upper()
        if country:
            query["country"] = country.upper()
        if from_date or to_date:
            query["pubDate"] = {
                **({"$gte": from_date} if from_date else {}),
                **({"$lte": to_date} if to_date else {}),
            }

        # relevance first keeps the map readable when many pins compete for space
        sort = [("relevance", -1), ("pubDate", -1)] if sort_by == "relevance" else [("pubDate", -1)]
        return await NewsGeo.find(query).sort(sort).limit(limit).to_list()

    @staticmethod
    async def get_top_stories(
        limit: int = 20,
        min_relevance: float = 0.7,
        from_date: datetime | None = None,
    ) -> list[NewsGeo]:
        """Globally most important located news — for the initial (zoomed-out) map."""
        query: dict = {"locatable": True, "relevance": {"$gte": min_relevance}}
        if from_date:
            query["pubDate"] = {"$gte": from_date}
        return await (
            NewsGeo.find(query)
            .sort([("relevance", -1), ("pubDate", -1)])   # uses relevance_pubDate index
            .limit(limit)
            .to_list()
        )

    @staticmethod
    async def get_country_counts(
        from_date: datetime | None = None,
        min_relevance: float = 0.0,
    ) -> list[dict]:
        """Counts per country + top relevance — for low zoom levels / overview badges."""
        match: dict = {"locatable": True}
        if min_relevance > 0:
            match["relevance"] = {"$gte": min_relevance}
        if from_date:
            match["pubDate"] = {"$gte": from_date}
        return await NewsGeo.aggregate([
            {"$match": match},
            {"$group": {
                "_id": "$country",
                "count": {"$sum": 1},
                "maxRelevance": {"$max": "$relevance"},
                "latestPubDate": {"$max": "$pubDate"},
            }},
            {"$sort": {"maxRelevance": -1, "count": -1}},
        ]).to_list()
```

Hinweis Antimeridian: Wenn die sichtbare Region die Datumsgrenze kreuzt
(`min_lon > max_lon`, z.B. Pazifik-Ansicht), die Box in zwei Queries splitten
(`[min_lon, 180]` und `[-180, max_lon]`) und Ergebnisse mergen. Für eine
Europa/US-fokussierte Finanz-App reicht es, diesen Fall clientseitig zu
vermeiden (Region clampen).

## 5. Endpoints — `app/api/v1/endpoints/news_geo.py`

```python
"""REST API endpoints for geolocated news (map feature)."""

from datetime import datetime

from fastapi import APIRouter, Query

from app.models.news_geo import NewsGeo
from app.schemas.news_geo import CountryCount, NewsGeoResponse
from app.services.news_geo import NewsGeoService

router = APIRouter()


def _to_response(item: NewsGeo) -> NewsGeoResponse:
    return NewsGeoResponse(
        id=str(item.id),
        newsId=str(item.newsId),
        lat=item.location.coordinates[1],   # GeoJSON: [lon, lat]
        lon=item.location.coordinates[0],
        country=item.country or "",
        place=item.place,
        precision=item.precision or "country",
        confidence=item.confidence,
        relevance=item.relevance,
        summary=item.summary,
        title=item.title,
        sourceName=item.sourceName,
        link=item.link,
        image=item.image,
        pubDate=item.pubDate,
        category=item.category,
    )


@router.get("", response_model=list[NewsGeoResponse])
async def get_geo_news(
    minLat: float = Query(..., ge=-90, le=90),
    minLon: float = Query(..., ge=-180, le=180),
    maxLat: float = Query(..., ge=-90, le=90),
    maxLon: float = Query(..., ge=-180, le=180),
    limit: int = Query(200, ge=1, le=500),
    minRelevance: float = Query(0.0, ge=0, le=1, description="0-1; raise it when zoomed out"),
    sortBy: str = Query("relevance", pattern="^(relevance|date)$"),
    category: str | None = Query(None, description="e.g. ECONOMY, POLITICS"),
    country: str | None = Query(None, min_length=2, max_length=2, description="ISO 3166-1 alpha-2"),
    fromDate: datetime | None = Query(None, description="Only news published after (ISO 8601)"),
    toDate: datetime | None = Query(None),
) -> list[NewsGeoResponse]:
    """Geolocated news inside the map viewport, most relevant first by default."""
    items = await NewsGeoService.get_in_viewport(
        min_lat=minLat, min_lon=minLon, max_lat=maxLat, max_lon=maxLon,
        limit=limit, min_relevance=minRelevance, sort_by=sortBy,
        category=category, country=country, from_date=fromDate, to_date=toDate,
    )
    return [_to_response(i) for i in items]


@router.get("/top", response_model=list[NewsGeoResponse])
async def get_top_geo_news(
    limit: int = Query(20, ge=1, le=100),
    minRelevance: float = Query(0.7, ge=0, le=1),
    fromDate: datetime | None = Query(None),
) -> list[NewsGeoResponse]:
    """Globally most important located news — for the initial map view."""
    items = await NewsGeoService.get_top_stories(
        limit=limit, min_relevance=minRelevance, from_date=fromDate
    )
    return [_to_response(i) for i in items]


@router.get("/countries", response_model=list[CountryCount])
async def get_geo_news_countries(
    fromDate: datetime | None = Query(None),
    minRelevance: float = Query(0.0, ge=0, le=1),
) -> list[CountryCount]:
    """Counts + top relevance per country (for zoomed-out map / badges)."""
    rows = await NewsGeoService.get_country_counts(
        from_date=fromDate, min_relevance=minRelevance
    )
    return [
        CountryCount(
            country=r["_id"],
            count=r["count"],
            maxRelevance=r["maxRelevance"],
            latestPubDate=r["latestPubDate"],
        )
        for r in rows
    ]
```

Registrierung in `app/api/v1/router.py` (gleiches Muster wie `news_graph`):

```python
from app.api.v1.endpoints import news_geo
# …
api_router.include_router(news_geo.router, prefix="/news-geo", tags=["news-geo"])
```

Ergibt: `GET /api/v1/news-geo?minLat=…&minLon=…&maxLat=…&maxLon=…` und
`GET /api/v1/news-geo/countries`. Auth-Dependency (z.B. `CurrentUserDep`)
nach House-Standard ergänzen — die Endpoints sind read-only.

## 6. App-Seite (MapKit, Kurzreferenz)

```swift
// Sichtbare Region → Query-Parameter:
let region = mapView.region
let minLat = region.center.latitude  - region.span.latitudeDelta  / 2
let maxLat = region.center.latitude  + region.span.latitudeDelta  / 2
let minLon = region.center.longitude - region.span.longitudeDelta / 2
let maxLon = region.center.longitude + region.span.longitudeDelta / 2

// Zoom-abhängiger Relevanz-Schwellwert: weit draußen nur die großen Stories,
// nah dran auch Lokales. Hält Pin-Zahl und Payload konstant klein.
func minRelevance(for span: MKCoordinateSpan) -> Double {
    switch span.latitudeDelta {
    case ..<2:    return 0.0    // Stadt-/Regionsebene: alles
    case ..<10:   return 0.3    // Landesebene
    case ..<40:   return 0.5    // Kontinent
    default:      return 0.7    // Weltansicht: nur Top-Stories
    }
}

// Response → Annotation:
let coord = CLLocationCoordinate2D(latitude: item.lat, longitude: item.lon)

// Pin-Styling nach relevance:
marker.markerTintColor = item.relevance >= 0.8 ? .systemRed
                       : item.relevance >= 0.5 ? .systemOrange
                       : .systemGray
marker.displayPriority = item.relevance >= 0.8 ? .required        // nie wegclippen
                       : item.relevance >= 0.5 ? .defaultHigh
                       : .defaultLow                              // darf verdeckt werden
marker.glyphImage = item.relevance >= 0.9 ? UIImage(systemName: "exclamationmark") : nil
```

- **Clustering:** `MKMarkerAnnotationView` mit `clusteringIdentifier = "news"` —
  MapKit clustert selbst und respektiert dabei `displayPriority`, d.h. bei
  Überlappung gewinnt automatisch die relevantere Story.
- **Erststart:** `/news-geo/top` (ohne Bounding-Box) füllt die Weltkarte sofort
  mit ~20 wichtigen Pins, bevor der erste Viewport-Request läuft.
- **Nachladen:** bei `regionDidChangeAnimated` (debounced ~300 ms) neu abfragen;
  `precision == "country"` ggf. anders darstellen (flächiger Pin) als `city`.

## 7. Performance & Betrieb

- Die Viewport-Query nutzt den 2dsphere-Index; `limit ≤ 500` hart deckeln
  (Schema oben tut das) — die Karte braucht nie mehr.
- **`minRelevance` ist der wirksamste Hebel:** In der Weltansicht liefert
  `minRelevance=0.7` statt hunderter Pins nur die relevanten — weniger DB-Arbeit,
  kleinere Payloads, lesbarere Karte. `/news-geo/top` läuft rein über den
  `{relevance:-1, pubDate:-1}`-Index (kein Geo-Scan).
- Daten ändern sich nur beim Agenten-Lauf (täglich 8:00): ein kurzer
  Response-Cache (60–300 s, z.B. `fastapi-cache` oder CDN-Header
  `Cache-Control: public, max-age=120`) eliminiert praktisch alle DB-Last.
- Die API braucht **keinen** Schreibzugriff auf `newsGeo` — Schreibweg ist
  ausschließlich MCP (`submit_news_locations`, Scope `write`).
- Monitoring-Idee: Alter von `max(locatedAt)` als Health-Signal — ist es > 48 h,
  läuft der Geo-Agent nicht (Desktop-App war zu / Task deaktiviert).

## 8. Smoke-Test nach Einbau

```bash
# Deutschland-Viewport, wichtigste zuerst
curl -s "https://api.finanz-copilot.de/api/v1/news-geo?minLat=47&minLon=5&maxLat=55&maxLon=16&limit=5" | python3 -m json.tool | head -40
# Weltansicht: nur Top-Stories
curl -s "https://api.finanz-copilot.de/api/v1/news-geo/top?limit=10" | python3 -m json.tool | head -30
# Länder-Badges
curl -s "https://api.finanz-copilot.de/api/v1/news-geo/countries" | python3 -m json.tool | head -20
```

Erwartung: Pins innerhalb Deutschlands (Box 47–55°N, 5–16°E) mit `lat`/`lon`,
`relevance`, `title`, `summary`, `image`; Top-Liste absteigend nach `relevance`;
Länderliste mit Counts und `maxRelevance`. Voraussetzung: der Geo-Agent ist
mindestens einmal gelaufen (sonst leere Arrays).
