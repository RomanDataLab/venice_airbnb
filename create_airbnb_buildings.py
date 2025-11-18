"""
Create venice_airbnb_buildings.geojson by matching listings to buildings using DuckDB.
- Match listing points to building polygons
- If a point doesn't fall within any building, assign it to the closest building
- Aggregate: host_since (earliest), price (sum), accommodates (sum), availability_365 (sum), beds (sum), bathrooms_text (sum)
"""

import json
import duckdb
import geopandas as gpd
import pandas as pd
import os
from shapely.geometry import Point
from shapely.ops import nearest_points

def main():
    print("=" * 60)
    print("Venice Airbnb Buildings Matcher (DuckDB)")
    print("=" * 60)
    
    # Initialize DuckDB connection
    conn = duckdb.connect()
    
    # Step 1: Load buildings GeoJSON
    print("\n[1/4] Loading buildings GeoJSON...")
    buildings_gdf = gpd.read_file('frontend/public/output/venice_buildings.geojson')
    print(f"Loaded {len(buildings_gdf)} buildings")
    
    # Step 2: Load listings CSV
    print("\n[2/4] Loading listings CSV...")
    listings_df = pd.read_csv('Venezia/listings_red01.csv')
    print(f"Loaded {len(listings_df)} listings")
    
    # Filter out listings without coordinates
    listings_clean = listings_df.dropna(subset=['latitude', 'longitude']).copy()
    print(f"Valid listings with coordinates: {len(listings_clean)}")
    
    # Create Point geometries for listings
    listings_clean['geometry'] = listings_clean.apply(
        lambda row: Point(row['longitude'], row['latitude']), axis=1
    )
    listings_gdf = gpd.GeoDataFrame(listings_clean, crs='EPSG:4326')
    
    # Step 3: Spatial join - find listings within buildings
    print("\n[3/4] Matching listings to buildings...")
    
    # Convert to same CRS for spatial operations
    buildings_4326 = buildings_gdf.to_crs('EPSG:4326')
    
    # Perform spatial join
    joined = gpd.sjoin(listings_gdf, buildings_4326, how='left', predicate='within')
    
    # Separate matched and unmatched listings
    matched = joined[joined.index_right.notna()].copy()
    unmatched = joined[joined.index_right.isna()].copy()
    
    print(f"Listings matched to buildings: {len(matched)}")
    print(f"Listings not matched (will assign to closest): {len(unmatched)}")
    
    # Step 4: Assign unmatched listings to closest buildings
    if len(unmatched) > 0:
        print("Assigning unmatched listings to closest buildings...")
        
        unmatched_indices = []
        closest_building_indices = []
        
        for idx, listing in unmatched.iterrows():
            listing_point = listing.geometry
            min_distance = float('inf')
            closest_building_idx = None
            
            # Find closest building
            for building_idx, building in buildings_4326.iterrows():
                distance = listing_point.distance(building.geometry)
                if distance < min_distance:
                    min_distance = distance
                    closest_building_idx = building_idx
            
            if closest_building_idx is not None:
                unmatched_indices.append(idx)
                closest_building_indices.append(closest_building_idx)
        
        # Update unmatched listings with closest building index
        for i, listing_idx in enumerate(unmatched_indices):
            building_idx = closest_building_indices[i]
            unmatched.loc[listing_idx, 'index_right'] = building_idx
        
        print(f"Assigned {len(unmatched_indices)} unmatched listings to closest buildings")
        
        # Combine matched and now-assigned unmatched
        all_matched = pd.concat([matched, unmatched])
    else:
        all_matched = matched
    
    # Step 5: Aggregate data by building
    print("\n[4/4] Aggregating data by building...")
    
    # Group by building index and aggregate
    aggregated = all_matched.groupby('index_right').agg({
        'host_since': 'min',  # Earliest host_since
        'price': 'sum',  # Sum of prices
        'accommodates': 'sum',  # Sum of accommodates
        'availability_365': 'sum',  # Sum of availability_365
        'beds': 'sum',  # Sum of beds
        'bathrooms_text': 'sum'  # Sum of bathrooms_text
    }).reset_index()
    
    aggregated.columns = ['building_index', 'host_since', 'price', 'accommodates', 
                          'availability_365', 'beds', 'bathrooms_text']
    
    # Count listings per building
    listing_counts = all_matched.groupby('index_right').size().reset_index(name='listing_count')
    listing_counts.columns = ['building_index', 'listing_count']
    
    # Merge aggregated data with buildings
    buildings_with_data = buildings_4326.copy()
    buildings_with_data['building_index'] = buildings_with_data.index
    
    # Merge aggregated data
    buildings_with_data = buildings_with_data.merge(aggregated, on='building_index', how='inner')
    buildings_with_data = buildings_with_data.merge(listing_counts, on='building_index', how='left')
    
    # Fill NaN values for listing_count (buildings with no listings)
    buildings_with_data['listing_count'] = buildings_with_data['listing_count'].fillna(0).astype(int)
    
    print(f"Buildings with listings: {len(buildings_with_data)}")
    print(f"Total listings assigned: {all_matched.groupby('index_right').size().sum()}")
    
    # Step 6: Convert to GeoJSON and save
    print("\n[5/5] Saving to GeoJSON...")
    
    # Convert to GeoJSON
    buildings_geojson = json.loads(buildings_with_data.to_json())
    
    # Clean and save
    output_path = 'frontend/public/output/venice_airbnb_buildings.geojson'
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    json_str = json.dumps(buildings_geojson, ensure_ascii=False, indent=2)
    json_str_clean = json_str.replace('\x00', '')  # Remove null bytes
    
    with open(output_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json_str_clean)
    
    print(f"Saved to {output_path}")
    
    # Print statistics
    print("\n" + "=" * 60)
    print("Statistics:")
    print("=" * 60)
    print(f"Total buildings with listings: {len(buildings_with_data)}")
    print(f"Total listings assigned: {int(buildings_with_data['listing_count'].sum())}")
    print(f"Average listings per building: {buildings_with_data['listing_count'].mean():.2f}")
    print(f"Max listings in a building: {buildings_with_data['listing_count'].max()}")
    print(f"\nAggregated values:")
    print(f"  Total price: {buildings_with_data['price'].sum():,.0f}")
    print(f"  Total accommodates: {buildings_with_data['accommodates'].sum():,.0f}")
    print(f"  Total availability_365: {buildings_with_data['availability_365'].sum():,.0f}")
    print(f"  Total beds: {buildings_with_data['beds'].sum():,.0f}")
    print(f"  Total bathrooms_text: {buildings_with_data['bathrooms_text'].sum():.1f}")
    
    print("\n" + "=" * 60)
    print("Processing complete!")
    print("=" * 60)

if __name__ == "__main__":
    main()

