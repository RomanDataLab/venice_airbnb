# Venice Airbnb Analytics Map

Interactive map visualization of Airbnb listings in Venice, Italy, with building classification and neighborhood statistics.

## Features

- **Interactive Map**: Explore Venice with Leaflet.js map interface
- **Building Classification**: View buildings colored by various metrics (listings, guest capacity, price, etc.)
- **Neighborhood Analytics**: Analyze neighborhoods with 7 different classification metrics
- **Multiple Views**: Switch between different data visualizations:
  - Guest Capacity per Night
  - Listings per Building
  - Cumulative Price per Night/Building
  - Since (host registration year)

## Tech Stack

- **Frontend**: Vite + Vanilla JavaScript
- **Mapping**: Leaflet.js
- **Data Processing**: Python (Geopandas, DuckDB)
- **Deployment**: Vercel

## Setup

### Frontend Development

```bash
cd frontend
npm install
npm run dev
```

### Data Processing

The Python scripts in the root directory are used for data processing:

- `fetch_venice_buildings.py` - Fetches building data from OpenStreetMap
- `create_airbnb_buildings.py` - Creates Airbnb building GeoJSON
- `enrich_neighborhoods.py` - Enriches neighborhoods with calculated statistics

## Deployment

The project is configured for Vercel deployment. The frontend is automatically built and deployed from the `frontend` directory.

