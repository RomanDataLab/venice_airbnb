"""
Fetch Venice building data from OpenStreetMap and classify by type using DuckDB
"""

import json
import requests
import duckdb
import geopandas as gpd
from shapely.geometry import shape
import os

# Venice municipality relation ID and ISTAT code
VENICE_RELATION_ID = 44741
VENICE_ISTAT_CODE = "027042"  # More reliable identifier

def fetch_osm_buildings():
    """Fetch building data from OpenStreetMap Overpass API for Venice municipality."""
    print("Fetching building data from OpenStreetMap...")
    print(f"Using Venice municipality boundary (relation {VENICE_RELATION_ID}, ISTAT: {VENICE_ISTAT_CODE})")
    
    overpass_url = "http://overpass-api.de/api/interpreter"
    
    # Try ISTAT code first (more reliable)
    query_istat = f"""
    [out:json][timeout:600];
    area["ref:ISTAT"="{VENICE_ISTAT_CODE}"]->.venice;
    (
      way["building"](area.venice);
      relation["building"](area.venice);
    );
    out geom;
    """
    
    # Fallback: use relation ID directly
    query_relation = f"""
    [out:json][timeout:600];
    rel({VENICE_RELATION_ID});
    map_to_area;
    ->.venice;
    (
      way["building"](area.venice);
      relation["building"](area.venice);
    );
    out geom;
    """
    
    # Try ISTAT code first
    try:
        print("Attempting to fetch using ISTAT code...")
        response = requests.post(overpass_url, data=query_istat, timeout=600)
        response.raise_for_status()
        data = response.json()
        elements = data.get('elements', [])
        if len(elements) > 0:
            print(f"Successfully fetched {len(elements)} building elements using ISTAT code")
            return data
        else:
            print("No elements found with ISTAT code, trying relation ID...")
            raise ValueError("No elements found")
    except Exception as e:
        print(f"ISTAT code method failed: {e}")
        print("Trying relation ID method...")
        try:
            response = requests.post(overpass_url, data=query_relation, timeout=600)
            response.raise_for_status()
            data = response.json()
            elements = data.get('elements', [])
            print(f"Successfully fetched {len(elements)} building elements using relation ID")
            return data
        except Exception as e2:
            print(f"Error fetching OSM data with relation ID: {e2}")
            return None

def convert_osm_to_geojson(osm_data):
    """Convert OSM data to GeoJSON format."""
    if not osm_data or 'elements' not in osm_data:
        return None
    
    features = []
    nodes = {}
    
    # First pass: collect all nodes
    for element in osm_data['elements']:
        if element['type'] == 'node':
            nodes[element['id']] = (element['lon'], element['lat'])
    
    # Second pass: convert ways and relations to features
    for element in osm_data['elements']:
        if element['type'] == 'way' and 'geometry' in element:
            # Extract tags
            tags = element.get('tags', {})
            building_type = tags.get('building', 'unknown')
            
            # Get coordinates from geometry
            coords = []
            for node in element['geometry']:
                coords.append([node['lon'], node['lat']])
            
            # Close polygon if not already closed
            if len(coords) > 2 and coords[0] != coords[-1]:
                coords.append(coords[0])
            
            if len(coords) >= 4:  # Valid polygon needs at least 4 points (including closing)
                feature = {
                    'type': 'Feature',
                    'geometry': {
                        'type': 'Polygon',
                        'coordinates': [coords]
                    },
                    'properties': {
                        'id': f"way_{element['id']}",
                        'building': building_type,
                        'name': tags.get('name', ''),
                        'amenity': tags.get('amenity', ''),
                        'tourism': tags.get('tourism', ''),
                        'shop': tags.get('shop', ''),
                        'office': tags.get('office', ''),
                        'leisure': tags.get('leisure', ''),
                        'building_levels': tags.get('building:levels', ''),
                        'addr_street': tags.get('addr:street', ''),
                        'addr_housenumber': tags.get('addr:housenumber', '')
                    }
                }
                features.append(feature)
    
    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }
    
    print(f"Converted {len(features)} buildings to GeoJSON")
    return geojson

def classify_buildings_with_duckdb(geojson_data):
    """Classify buildings by type using DuckDB."""
    print("Classifying buildings with DuckDB...")
    
    # Convert GeoJSON to GeoDataFrame
    gdf = gpd.GeoDataFrame.from_features(geojson_data['features'])
    
    # Create DuckDB connection
    conn = duckdb.connect()
    
    # Convert GeoDataFrame to pandas DataFrame (without geometry) for DuckDB
    df = gdf.drop(columns=['geometry']).copy()
    
    # Register DataFrame with DuckDB
    conn.register('buildings', df)
    
    # Classify buildings based on OSM tags
    # Priority: tourism=hotel > amenity > building tag > other tags
    classification_query = """
    SELECT 
        *,
        CASE 
            WHEN tourism = 'hotel' OR tourism = 'hostel' OR tourism = 'apartment' THEN 'hotel'
            WHEN amenity = 'restaurant' OR amenity = 'cafe' OR amenity = 'bar' OR amenity = 'fast_food' THEN 'restaurant'
            WHEN amenity = 'school' OR amenity = 'university' OR amenity = 'college' THEN 'education'
            WHEN amenity = 'hospital' OR amenity = 'clinic' OR amenity = 'pharmacy' THEN 'healthcare'
            WHEN amenity = 'place_of_worship' OR amenity = 'church' THEN 'religious'
            WHEN shop IS NOT NULL AND shop != '' THEN 'commercial'
            WHEN office IS NOT NULL AND office != '' THEN 'office'
            WHEN leisure IS NOT NULL AND leisure != '' THEN 'leisure'
            WHEN building = 'residential' OR building = 'house' OR building = 'apartments' THEN 'residential'
            WHEN building = 'commercial' OR building = 'retail' THEN 'commercial'
            WHEN building = 'industrial' OR building = 'warehouse' THEN 'industrial'
            WHEN building = 'hotel' THEN 'hotel'
            WHEN building = 'school' OR building = 'university' THEN 'education'
            WHEN building = 'hospital' OR building = 'clinic' THEN 'healthcare'
            WHEN building = 'church' OR building = 'cathedral' OR building = 'mosque' OR building = 'synagogue' THEN 'religious'
            WHEN building = 'public' OR building = 'civic' THEN 'public'
            WHEN building = 'garage' OR building = 'parking' THEN 'parking'
            WHEN building = 'yes' THEN 'unknown'
            ELSE COALESCE(building, 'unknown')
        END as building_type_classified
    FROM buildings
    """
    
    classified_df = conn.execute(classification_query).df()
    
    # Get statistics
    stats_query = """
    SELECT 
        building_type_classified,
        COUNT(*) as count
    FROM (""" + classification_query + """) classified
    GROUP BY building_type_classified
    ORDER BY count DESC
    """
    
    stats = conn.execute(stats_query).df()
    
    print("\nBuilding classification statistics:")
    print(stats.to_string(index=False))
    
    conn.close()
    
    # Merge classification back with geometry
    classified_gdf = gdf.copy()
    classified_gdf['building_type_classified'] = classified_df['building_type_classified'].values
    
    return classified_gdf

def save_geojson(gdf, output_path):
    """Save GeoDataFrame to GeoJSON file."""
    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Convert to GeoJSON dict and save with json.dump for browser compatibility
    import re
    geojson_dict = json.loads(gdf.to_json())
    # Clean the JSON string to remove any control characters
    json_str = json.dumps(geojson_dict, ensure_ascii=False, indent=2)
    json_str_clean = re.sub(r'[\x00-\x08\x0B\x0C\x0E-\x1F]', '', json_str)
    with open(output_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json_str_clean)
    print(f"\nSaved classified buildings to {output_path}")
    print(f"Total buildings: {len(gdf)}")

def main():
    """Main execution function."""
    print("=" * 60)
    print("Venice Building Data Fetcher and Classifier")
    print("=" * 60)
    
    # Step 1: Fetch OSM data
    osm_data = fetch_osm_buildings()
    if not osm_data:
        print("Failed to fetch OSM data")
        return
    
    # Step 2: Convert to GeoJSON
    geojson_data = convert_osm_to_geojson(osm_data)
    if not geojson_data:
        print("Failed to convert OSM data to GeoJSON")
        return
    
    # Step 3: Classify with DuckDB
    classified_gdf = classify_buildings_with_duckdb(geojson_data)
    
    # Step 4: Save to GeoJSON
    output_path = 'frontend/public/output/venice_buildings_classified.geojson'
    save_geojson(classified_gdf, output_path)
    
    print("\n" + "=" * 60)
    print("Processing complete!")
    print("=" * 60)

if __name__ == "__main__":
    main()

