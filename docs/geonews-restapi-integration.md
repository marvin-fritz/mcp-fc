# GeoNews → REST-API-Integration (webapi)

Anleitung, um die vom MCP/Geo-Agenten befüllten `enrichment`-Daten der
`news`-Collection in der FastAPI-webapi (`api.finanz-copilot.de`)
bereitzustellen — als Datenquelle für die MapKit-Karte in der App.
Zugeschnitten auf die bestehende Struktur (Beanie-Models, Service-Layer,
`app/api/v1/endpoints/`).

## 1. Datenmodell

Quelle ist jetzt die `news`-Collection selbst. Der Geo-Agent schreibt einen
`enrichment`-Block direkt an das news-Dokument (Upsert per `$set` durch das
MCP-Tool `submit_news_locations`); `newsGeo` wurde am 2026-08-12 gedroppt
(Phase 5 abgeschlossen).

| Feld | Typ | Bedeutung |
|---|---|---|
| `enrichment` | object? | fehlt = noch nicht vom Agenten bearbeitet |
| `enrichment.enrichedBy` / `enrichedAt` | str / date | Agent-Name (z.B. `fcNewsAgent`; ältere Docs: Auth-Identität/E-Mail) + Zeitstempel |
| `enrichment.relevance` | float? | 0–1 — Bedeutung des EREIGNISSES (auch ohne Ort gesetzt) |
| `enrichment.headline` | str? | kurze deutsche Schlagzeile (≤90 Zeichen, ehem. `geoTitle`) |
| `enrichment.summary` | str? | 1–2 Sätze (Pin-Callout / Teaser) |
| `enrichment.topics` | [str]? | 1–8 Themen-Tags, Englisch, Title Case (`"US Economy"`, `"DAX"`, auch Personen: `"Zohran Mamdani"`) |
| `enrichment.geo.locatable` | bool | `false` = kein sinnvoller Ort (**für die Karte filtern!**) |
| `enrichment.geo.location` | GeoJSON Point | `[lon, lat]` — Reihenfolge beachten |
| `enrichment.geo.country` | str? | ISO 3166-1 alpha-2, uppercase |
| `enrichment.geo.place` | str? | Anzeigename, fehlt bei `precision=country` |
| `enrichment.geo.precision` | str? | `country` \| `region` \| `city` |
| `enrichment.geo.confidence` | float? | 0–1 — Sicherheit der VERORTUNG |
| `title`, `sourceName`, `link`, `image`, `pubDate`, `category` | — | native news-Felder — **keine Denormalisierung mehr nötig** |

Die früheren Top-Level-Duplikate (`relevance`, `geoTitle`, `geoSummary`,
`country`, `place`, `geoLocatedAt`) wurden am 2026-08-12 entfernt —
`enrichment.*` ist der einzige Ort für Agenten-Daten.

**relevance-Skala** (vom Agenten vergeben, feste Ankerpunkte):

| Wert | Bedeutung | Beispiele |
|---|---|---|
| 0.95–1.0 | historischer Schock | 11. September, Kriegsausbruch, Marktcrash, Bankenkollaps |
| 0.8–0.94 | groß | Notenbank-Überraschung, Eskalation Iran-Konflikt, Mega-Merger |
| 0.6–0.79 | bedeutend | erwarteter Zinsentscheid, Large-Cap-Quartalszahlen, nationale Wahl |
| 0.4–0.59 | mittel | Mid-Cap-News, Branchenberichte |
| 0.2–0.39 | Routine | Small-Cap-PR, Analystenkommentare |
| 0–0.19 | trivial | irrelevantes Rauschen |

Indizes (via mcp-fc `ensure-indexes` / `scripts/ensure-indexes.ts` angelegt):
`enrichment_location_2dsphere` auf `enrichment.geo.location` (sparse),
`enrichment_relevance_pubDate` auf `{'enrichment.relevance':-1, pubDate:-1}`,
`enrichment_country_pubDate` auf `{'enrichment.geo.country':1, pubDate:-1}`,
`enrichment_topics_pubDate` auf `{'enrichment.topics':1, pubDate:-1}`.
Viewport- und Top-Stories-Queries laufen also ohne weitere Vorbereitung über
einen Index.

Befüllung: täglich 8:00 Uhr durch den Geo-Agenten (Claude-Scheduled-Task) —
die Daten sind **nicht** realtime; `enrichment.enrichedAt` zeigt die Aktualität.

> **Achtung bei neuen Feldern:** Der Agent ist eine Scheduled-Task mit eigenem
> Auftragstext, der außerhalb dieses Repos liegt. Ein Feld im Tool-Schema
> anzulegen reicht **nicht** — zählt der Auftragstext die einzureichenden Felder
> auf, füllt der Agent nur diese. Bei jeder Erweiterung von
> `submit_news_locations` also auch die Routine anpassen, sonst bleibt das neue
> Feld dauerhaft leer, ohne dass irgendetwas fehlschlägt. Der aktuelle Auftragstext liegt als Kopiervorlage in docs/geonews-agent-routine.md.

## 2. Beanie-Model — `app/models/news_geo.py`

Modul- und Klassennamen aus der bisherigen webapi-Struktur (`news_geo.py`,
`NewsGeoService` usw.) bleiben bestehen — geändert haben sich nur die
zugrunde liegende Collection (`news` statt `newsGeo`) und die Feldpfade.
Das Document-Model selbst heißt jetzt `News` (embeddet `Enrichment`/`GeoBlock`)
statt `NewsGeo`:

```python
"""Beanie Document models for the news collection (map feature).

`GeoBlock` und `Enrichment` sind in `News.enrichment` eingebettet und werden
vom mcp-fc-Geolokalisierungs-Agenten über `submit_news_locations` befüllt.
"""

from datetime import datetime

from beanie import Document
from pydantic import BaseModel


class GeoPoint(BaseModel):
    """GeoJSON Point. coordinates = [longitude, latitude] (WGS84)."""

    type: str = "Point"
    coordinates: list[float]  # [lon, lat]


class GeoBlock(BaseModel):
    locatable: bool = True
    location: GeoPoint | None = None
    country: str | None = None
    place: str | None = None
    precision: str | None = None
    confidence: float | None = None


class Enrichment(BaseModel):
    enrichedBy: str
    enrichedAt: datetime
    relevance: float | None = None
    headline: str | None = None
    summary: str | None = None
    topics: list[str] | None = None
    geo: GeoBlock


class News(Document):
    title: str
    description: str | None = None
    sourceName: str
    link: str
    image: str | None = None
    pubDate: datetime
    category: str
    enrichment: Enrichment | None = None

    class Settings:
        name = "news"
```

**Wichtig:** Die webapi hat für die `news`-Collection sehr wahrscheinlich
bereits ein `News`-Document-Model (z.B. `app/models/news.py`) in der
`document_models`-Liste der Beanie-Initialisierung registriert (dort, wo auch
`NewsSource` etc. stehen — z.B. `app/core/db.py` / `init_beanie(...)`). Hier
nicht zusätzlich registrieren, sondern das bestehende `News`-Model um das
optionale `enrichment: Enrichment | None = None`-Feld (plus die
`GeoBlock`/`Enrichment`-Submodels) erweitern — eine zweite `Document`-Klasse
für dieselbe Collection würde zu einer doppelten Beanie-Registrierung führen.
Beanie legt keine Indizes an, die existieren bereits (via mcp-fc
`ensure-indexes`) — keine `Indexed`-Annotationen nötig.

## 3. Response-Schema — `app/schemas/news_geo.py`

Für die App flach und MapKit-freundlich (lat/lon getrennt statt GeoJSON):

```python
"""Response schemas for geolocated news."""

from datetime import datetime

from pydantic import BaseModel


class NewsGeoResponse(BaseModel):
    id: str                    # news._id
    newsId: str                # news._id — identisch mit id, für Detail-Navigation
                                # (kein separates newsGeo-Dokument mehr, daher gleicher Wert)
    lat: float
    lon: float
    country: str
    place: str | None = None
    precision: str
    confidence: float | None = None
    relevance: float           # 0-1 → Pin-Größe/Farbe in der App
    headline: str | None = None
    summary: str | None = None
    topics: list[str] | None = None
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
"""Service for geolocated news (map feature) — reads news.enrichment."""

from datetime import datetime

from app.models.news_geo import News


class NewsGeoService:
    """Read-only access to news.enrichment. Writes happen via the mcp-fc agent."""

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
    ) -> list[News]:
        """Located news inside the map viewport, most relevant (or newest) first."""
        query: dict = {
            "enrichment.geo.locatable": True,
            "enrichment.geo.location": {
                "$geoWithin": {
                    "$geometry": NewsGeoService._bbox_polygon(min_lat, min_lon, max_lat, max_lon)
                }
            },
        }
        if min_relevance > 0:
            query["enrichment.relevance"] = {"$gte": min_relevance}
        if category:
            query["category"] = category.upper()
        if country:
            query["enrichment.geo.country"] = country.upper()
        if from_date or to_date:
            query["pubDate"] = {
                **({"$gte": from_date} if from_date else {}),
                **({"$lte": to_date} if to_date else {}),
            }

        # relevance first keeps the map readable when many pins compete for space
        sort = [("enrichment.relevance", -1), ("pubDate", -1)] if sort_by == "relevance" else [("pubDate", -1)]
        return await News.find(query).sort(sort).limit(limit).to_list()

    @staticmethod
    async def get_top_stories(
        limit: int = 20,
        min_relevance: float = 0.7,
        from_date: datetime | None = None,
    ) -> list[News]:
        """Globally most important located news — for the initial (zoomed-out) map."""
        query: dict = {"enrichment.geo.locatable": True, "enrichment.relevance": {"$gte": min_relevance}}
        if from_date:
            query["pubDate"] = {"$gte": from_date}
        return await (
            News.find(query)
            .sort([("enrichment.relevance", -1), ("pubDate", -1)])   # uses enrichment_relevance_pubDate index
            .limit(limit)
            .to_list()
        )

    @staticmethod
    async def get_country_counts(
        from_date: datetime | None = None,
        min_relevance: float = 0.0,
    ) -> list[dict]:
        """Counts per country + top relevance — for low zoom levels / overview badges."""
        match: dict = {"enrichment.geo.locatable": True}
        if min_relevance > 0:
            match["enrichment.relevance"] = {"$gte": min_relevance}
        if from_date:
            match["pubDate"] = {"$gte": from_date}
        return await News.aggregate([
            {"$match": match},
            {"$group": {
                "_id": "$enrichment.geo.country",
                "count": {"$sum": 1},
                "maxRelevance": {"$max": "$enrichment.relevance"},
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

from app.models.news_geo import News
from app.schemas.news_geo import CountryCount, NewsGeoResponse
from app.services.news_geo import NewsGeoService

router = APIRouter()


def _to_response(item: News) -> NewsGeoResponse:
    # Alle Aufrufer filtern vorher auf "enrichment.geo.locatable": True
    # (siehe NewsGeoService) — enrichment und enrichment.geo sind hier also
    # garantiert gesetzt, kein zusätzlicher None-Check nötig.
    enrichment = item.enrichment
    geo = enrichment.geo
    return NewsGeoResponse(
        id=str(item.id),
        newsId=str(item.id),               # kein separates newsGeo-Dokument mehr
        lat=geo.location.coordinates[1],   # GeoJSON: [lon, lat]
        lon=geo.location.coordinates[0],
        country=geo.country or "",
        place=geo.place,
        precision=geo.precision or "country",
        confidence=geo.confidence,
        relevance=enrichment.relevance or 0.0,
        headline=enrichment.headline,
        summary=enrichment.summary,
        topics=enrichment.topics,
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

- Die Viewport-Query nutzt den `enrichment_location_2dsphere`-Index;
  `limit ≤ 500` hart deckeln (Schema oben tut das) — die Karte braucht nie mehr.
- **`minRelevance` ist der wirksamste Hebel:** In der Weltansicht liefert
  `minRelevance=0.7` statt hunderter Pins nur die relevanten — weniger DB-Arbeit,
  kleinere Payloads, lesbarere Karte. `/news-geo/top` läuft rein über den
  `enrichment_relevance_pubDate`-Index (`{'enrichment.relevance':-1, pubDate:-1}`,
  kein Geo-Scan).
- Daten ändern sich nur beim Agenten-Lauf (täglich 8:00): ein kurzer
  Response-Cache (60–300 s, z.B. `fastapi-cache` oder CDN-Header
  `Cache-Control: public, max-age=120`) eliminiert praktisch alle DB-Last.
- Die API braucht **keinen** Schreibzugriff auf `news` — Schreibweg ist
  ausschließlich MCP (`submit_news_locations`, Scope `write`).
- Monitoring-Idee: Alter von `max(news.enrichment.enrichedAt)` als Health-Signal
  — ist es > 48 h, läuft der Geo-Agent nicht (Desktop-App war zu / Task
  deaktiviert). Health-Signal ist jetzt `max(news.enrichment.enrichedAt)` statt
  `max(newsGeo.locatedAt)`.

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
`relevance`, `title`, `summary`, `image`; jetzt zusätzlich `headline` und
`topics` (aus `enrichment.headline`/`enrichment.topics`, können bei älteren,
noch nicht neu anreicherten Items `null` sein); Top-Liste absteigend nach
`relevance`; Länderliste mit Counts und `maxRelevance`. Voraussetzung: der
Geo-Agent ist mindestens einmal gelaufen (sonst leere Arrays).
