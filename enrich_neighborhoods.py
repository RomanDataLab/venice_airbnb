"""
Enrich neighborhoods GeoJSON with listing statistics.
Calculates aggregations for listings within each neighborhood polygon.
"""

import geopandas as gpd
import pandas as pd
import numpy as np
import json
import os
from shapely.geometry import Point

def enrich_neighborhoods():
    """Enrich neighborhoods with listing statistics from buildings."""
    print("=" * 60)
    print("Enriching Neighborhoods with Listing Statistics")
    print("=" * 60)
    
    # File paths
    neighborhoods_path = 'frontend/public/output/venice_barri_processed.geojson'
    buildings_path = 'frontend/public/output/venice_airbnb_buildings.geojson'
    output_path = 'frontend/public/output/venice_barri_processed.geojson'
    
    # Step 1: Load neighborhoods GeoJSON
    print("\n[1/4] Loading neighborhoods GeoJSON...")
    neighborhoods_gdf = gpd.read_file(neighborhoods_path)
    print(f"Loaded {len(neighborhoods_gdf)} neighborhoods")
    
    # Step 2: Load buildings GeoJSON
    print("\n[2/4] Loading buildings GeoJSON...")
    buildings_gdf = gpd.read_file(buildings_path)
    print(f"Loaded {len(buildings_gdf)} buildings")
    
    # Ensure both are in the same CRS
    if neighborhoods_gdf.crs != buildings_gdf.crs:
        print(f"Converting CRS: neighborhoods {neighborhoods_gdf.crs} -> buildings {buildings_gdf.crs}")
        neighborhoods_gdf = neighborhoods_gdf.to_crs(buildings_gdf.crs)
    
    # Step 3: Perform spatial join to find buildings within each neighborhood
    print("\n[3/4] Performing spatial join (buildings within neighborhoods)...")
    
    # Create a spatial index for buildings for faster joins
    buildings_sindex = buildings_gdf.sindex
    
    # Initialize result columns
    neighborhoods_gdf['listings_total'] = 0
    neighborhoods_gdf['total_guests_per_night'] = 0.0
    neighborhoods_gdf['guest_night_capacity_per_year'] = 0.0
    neighborhoods_gdf['total_price_per_night'] = 0.0
    neighborhoods_gdf['median_price_per_unit'] = None
    neighborhoods_gdf['max_price_per_unit'] = None
    neighborhoods_gdf['min_price_per_unit'] = None
    
    # Process each neighborhood
    for idx, neighborhood in neighborhoods_gdf.iterrows():
        # Find buildings that might intersect with this neighborhood using spatial index
        possible_matches_index = list(buildings_sindex.intersection(neighborhood.geometry.bounds))
        possible_matches = buildings_gdf.iloc[possible_matches_index]
        
        # Filter to only buildings that are actually within this neighborhood
        # Using 'within' to ensure buildings are completely inside the neighborhood polygon
        buildings_in_neighborhood = possible_matches[possible_matches.geometry.within(neighborhood.geometry)]
        
        if len(buildings_in_neighborhood) > 0:
            # Get relevant columns
            listing_counts = buildings_in_neighborhood['listing_count'].fillna(0)
            accommodates = buildings_in_neighborhood['accommodates'].fillna(0)
            availability = buildings_in_neighborhood['availability_365'].fillna(0)
            prices = buildings_in_neighborhood['price'].fillna(0)
            
            # Calculate aggregations
            # listings total: sum of listing_count
            neighborhoods_gdf.at[idx, 'listings_total'] = int(listing_counts.sum())
            
            # total guests per night: sum of accommodates * listing_count
            total_guests = (accommodates * listing_counts).sum()
            neighborhoods_gdf.at[idx, 'total_guests_per_night'] = float(total_guests)
            
            # guest-night capacity per year: sum of accommodates * availability_365 * listing_count
            guest_night_capacity = (accommodates * availability * listing_counts).sum()
            neighborhoods_gdf.at[idx, 'guest_night_capacity_per_year'] = float(guest_night_capacity)
            
            # total price per night: sum of price (price is already total for building)
            neighborhoods_gdf.at[idx, 'total_price_per_night'] = float(prices.sum())
            
            # Price statistics per unit (price per listing)
            # Calculate price per unit for each building: price / listing_count
            # Only consider buildings with valid prices > 0 and listing_count > 0
            valid_mask = (prices > 0) & (listing_counts > 0)
            if valid_mask.sum() > 0:
                prices_per_unit = prices[valid_mask] / listing_counts[valid_mask]
                neighborhoods_gdf.at[idx, 'median_price_per_unit'] = float(prices_per_unit.median())
                neighborhoods_gdf.at[idx, 'max_price_per_unit'] = float(prices_per_unit.max())
                neighborhoods_gdf.at[idx, 'min_price_per_unit'] = float(prices_per_unit.min())
        
        # Progress indicator
        if (idx + 1) % 10 == 0:
            print(f"  Processed {idx + 1}/{len(neighborhoods_gdf)} neighborhoods...")
    
    print(f"Completed processing all {len(neighborhoods_gdf)} neighborhoods")
    
    # Step 4: Save enriched neighborhoods GeoJSON
    print("\n[4/4] Saving enriched neighborhoods GeoJSON...")
    
    # Convert to GeoJSON dict
    neighborhoods_geojson = json.loads(neighborhoods_gdf.to_json())
    
    # Save with proper formatting
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(neighborhoods_geojson, f, ensure_ascii=False, indent=2)
    
    print(f"Saved enriched neighborhoods to {output_path}")
    
    # Print summary statistics
    print("\n" + "=" * 60)
    print("Summary Statistics:")
    print("=" * 60)
    print(f"Total neighborhoods: {len(neighborhoods_gdf)}")
    print(f"Neighborhoods with listings: {(neighborhoods_gdf['listings_total'] > 0).sum()}")
    print(f"\nAggregated totals across all neighborhoods:")
    print(f"  Total listings: {neighborhoods_gdf['listings_total'].sum():,}")
    print(f"  Total guests per night: {neighborhoods_gdf['total_guests_per_night'].sum():,.0f}")
    print(f"  Guest-night capacity per year: {neighborhoods_gdf['guest_night_capacity_per_year'].sum():,.0f}")
    print(f"  Total price per night: €{neighborhoods_gdf['total_price_per_night'].sum():,.2f}")
    
    # Show top neighborhoods by listings
    print("\nTop 5 neighborhoods by listings:")
    # Get available columns
    available_cols = ['listings_total', 'total_guests_per_night', 'total_price_per_night']
    name_cols = []
    for col in ['neighbourhood', 'name', 'NOME', 'nome']:
        if col in neighborhoods_gdf.columns:
            name_cols.append(col)
            break
    
    if name_cols:
        available_cols = name_cols + available_cols
    
    top_neighborhoods = neighborhoods_gdf.nlargest(5, 'listings_total')[available_cols]
    for _, row in top_neighborhoods.iterrows():
        # Try to get name from various possible columns
        name = 'Unknown'
        for col in ['neighbourhood', 'name', 'NOME', 'nome']:
            if col in row.index and pd.notna(row[col]):
                name = str(row[col])
                break
        
        print(f"  {name}: {int(row['listings_total'])} listings, "
              f"{row['total_guests_per_night']:.0f} guests/night, "
              f"€{row['total_price_per_night']:,.2f}/night")
    
    print("\n" + "=" * 60)
    print("Enrichment complete!")
    print("=" * 60)

if __name__ == "__main__":
    enrich_neighborhoods()

