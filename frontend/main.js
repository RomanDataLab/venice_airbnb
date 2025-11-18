import L from 'leaflet';
import { stadiaMapsConfig } from './config.js';

// Fix for default marker icon in Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Initialize map - will zoom to Venice island bounds after data loads
const map = L.map('map').setView([45.4408, 12.3155], 13);

// Add Alidade Smooth Dark tile layer (via Stadia Maps)
const stadiaMapsUrl = `https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=${stadiaMapsConfig.apiKey}`;
L.tileLayer(stadiaMapsUrl, {
  attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
  maxZoom: 20
}).addTo(map);

// Global variables
let buildingsLayer = null;
let buildingsData = null;
let currentColorMode = 'listing_count'; // Default to listing_count (red button)
let jenksBreaks = {};
let barriLayer = null;
let barriLabelsLayer = null;
let neighborhoodsVisible = false; // Track if neighborhoods are visible
let neighborhoodClassificationKey = null; // Track current neighborhood classification key
let neighborhoodJenksBreaks = {}; // Store Jenks breaks for neighborhood properties
let neighborhoodGeoJSONData = null; // Store neighborhood GeoJSON data
let neighborhoodTooltip = null; // Single tooltip element for all neighborhoods

// Jenks natural breaks algorithm (simplified version) - minimizes within-class variance
function calculateJenksBreaksFromData(data, numClasses) {
  if (data.length === 0) return [];
  
  data = data.filter(d => d !== null && d !== undefined && !isNaN(d)).sort((a, b) => a - b);
  if (data.length === 0) return [];
  
  const min = data[0];
  const max = data[data.length - 1];
  
  if (min === max) {
    // If all values are the same, return array with min and max
    return [min, max];
  }
  
  // Remove duplicates but keep track of unique values
  const uniqueData = [...new Set(data)];
  
  if (uniqueData.length <= numClasses) {
    // If we have fewer unique values than classes, use all unique values
    return uniqueData.sort((a, b) => a - b);
  }
  
  const breaks = [min]; // Minimum value
  const classSize = Math.floor(uniqueData.length / numClasses);
  
  // Create breaks that minimize variance within classes
  // Use unique data to ensure we get distinct breaks
  for (let i = 1; i < numClasses; i++) {
    const idx = Math.min(i * classSize, uniqueData.length - 1);
    breaks.push(uniqueData[idx]);
  }
  breaks.push(max); // Maximum value
  
  // Remove duplicates and ensure we have exactly numClasses + 1 breaks (for numClasses intervals)
  const uniqueBreaks = [...new Set(breaks)].sort((a, b) => a - b);
  
  // If we have fewer breaks than needed, interpolate between existing breaks
  if (uniqueBreaks.length < numClasses + 1) {
    const finalBreaks = [uniqueBreaks[0]];
    const step = (uniqueBreaks.length - 1) / numClasses;
    
    for (let i = 1; i < numClasses; i++) {
      const pos = i * step;
      const lowerIdx = Math.floor(pos);
      const upperIdx = Math.ceil(pos);
      const lowerVal = uniqueBreaks[lowerIdx];
      const upperVal = uniqueBreaks[upperIdx];
      
      if (lowerIdx === upperIdx) {
        finalBreaks.push(lowerVal);
      } else {
        const factor = pos - lowerIdx;
        const interpolated = lowerVal + (upperVal - lowerVal) * factor;
        finalBreaks.push(interpolated);
      }
    }
    finalBreaks.push(uniqueBreaks[uniqueBreaks.length - 1]);
    return finalBreaks;
  }
  
  return uniqueBreaks;
}

// Color interpolation functions
function interpolateColor(color1, color2, factor) {
  // Handle both hex and rgb colors
  let c1, c2;
  
  if (color1.startsWith('#')) {
    c1 = {
      r: parseInt(color1.slice(1, 3), 16),
      g: parseInt(color1.slice(3, 5), 16),
      b: parseInt(color1.slice(5, 7), 16)
    };
  } else if (color1.startsWith('rgb')) {
    const match = color1.match(/\d+/g);
    c1 = { r: parseInt(match[0]), g: parseInt(match[1]), b: parseInt(match[2]) };
  } else {
    c1 = { r: 0, g: 0, b: 0 };
  }
  
  if (color2.startsWith('#')) {
    c2 = {
      r: parseInt(color2.slice(1, 3), 16),
      g: parseInt(color2.slice(3, 5), 16),
      b: parseInt(color2.slice(5, 7), 16)
    };
  } else if (color2.startsWith('rgb')) {
    const match = color2.match(/\d+/g);
    c2 = { r: parseInt(match[0]), g: parseInt(match[1]), b: parseInt(match[2]) };
  } else {
    c2 = { r: 0, g: 0, b: 0 };
  }
  
  const r = Math.round(c1.r + (c2.r - c1.r) * factor);
  const g = Math.round(c1.g + (c2.g - c1.g) * factor);
  const b = Math.round(c1.b + (c2.b - c1.b) * factor);
  
  return `#${[r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("")}`;
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

// Get color for value based on breaks and palette
function getColorForValue(value, breaks, palette) {
  if (value === null || value === undefined || isNaN(value)) {
    return '#999999'; // Grey for no data
  }
  
  if (breaks.length < 2) return palette[0];
  
  const numIntervals = breaks.length - 1;
  
  // Find which class the value belongs to
  for (let i = 0; i < numIntervals; i++) {
    // For the last interval, use <= to include the max value
    const isLastInterval = (i === numIntervals - 1);
    const compareValue = isLastInterval ? breaks[i + 1] + 0.0001 : breaks[i + 1];
    
    if (value <= compareValue) {
      // Map interval index to palette index (0 to palette.length-1)
      const paletteIndex = Math.min(i, palette.length - 1);
      
      // Interpolate color within the interval
      if (breaks[i + 1] !== breaks[i]) {
        const factor = (value - breaks[i]) / (breaks[i + 1] - breaks[i]);
        // Clamp factor between 0 and 1
        const clampedFactor = Math.max(0, Math.min(1, factor));
        
        // If not the last interval and not the last palette color, interpolate
        if (i < numIntervals - 1 && i < palette.length - 1) {
          return interpolateColor(palette[i], palette[i + 1], clampedFactor);
        } else {
          // Use the color for this interval
          return palette[paletteIndex];
        }
      } else {
        return palette[paletteIndex];
      }
    }
  }
  
  // If value is greater than all breaks, use last palette color
  return palette[palette.length - 1];
}

// Color palettes
const palettes = {
  hosts_number: ['#0000FF', '#4000BF', '#800080', '#BF0040', '#FF0000'], // Blue to Red-Purple
  price: ['#FFFF00', '#CCFF33', '#99FF66', '#66FF99', '#33FFCC', '#00FF00'], // Yellow to Green
  capacity_night: ['#00FF00', '#00CC66', '#0099CC', '#0066CC', '#0033CC', '#0000CC'], // Green to Dark Blue
  capacity_year: ['#00FF00', '#66CC00', '#99CC00', '#CC9900', '#CC6600', '#CC0000'] // Green to Dark Red
};

// Generate palette with 10 colors
function generatePalette(startColor, endColor, numColors) {
  const colors = [];
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    colors.push(interpolateColor(startColor, endColor, factor));
  }
  return colors;
}

// Generate spring_r palette (reversed spring: yellow -> cyan -> magenta)
function generateSpringRPalette(numColors) {
  const colors = [];
  // Spring_r goes from yellow (#FFFF00) through cyan (#00FFFF) to magenta (#FF00FF)
  const yellow = { r: 255, g: 255, b: 0 };
  const cyan = { r: 0, g: 255, b: 255 };
  const magenta = { r: 255, g: 0, b: 255 };
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.5) {
      // Yellow to Cyan
      const localFactor = factor * 2;
      r = Math.round(yellow.r + (cyan.r - yellow.r) * localFactor);
      g = Math.round(yellow.g + (cyan.g - yellow.g) * localFactor);
      b = Math.round(yellow.b + (cyan.b - yellow.b) * localFactor);
    } else {
      // Cyan to Magenta
      const localFactor = (factor - 0.5) * 2;
      r = Math.round(cyan.r + (magenta.r - cyan.r) * localFactor);
      g = Math.round(cyan.g + (magenta.g - cyan.g) * localFactor);
      b = Math.round(cyan.b + (magenta.b - cyan.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate cool palette (blues/cyans - cool colors)
function generateCoolPalette(numColors) {
  const colors = [];
  // Cool palette goes from dark blue to cyan
  const darkBlue = { r: 0, g: 51, b: 102 };
  const blue = { r: 0, g: 102, b: 204 };
  const lightBlue = { r: 51, g: 153, b: 255 };
  const cyan = { r: 0, g: 255, b: 255 };
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.33) {
      // Dark blue to blue
      const localFactor = factor / 0.33;
      r = Math.round(darkBlue.r + (blue.r - darkBlue.r) * localFactor);
      g = Math.round(darkBlue.g + (blue.g - darkBlue.g) * localFactor);
      b = Math.round(darkBlue.b + (blue.b - darkBlue.b) * localFactor);
    } else if (factor <= 0.66) {
      // Blue to light blue
      const localFactor = (factor - 0.33) / 0.33;
      r = Math.round(blue.r + (lightBlue.r - blue.r) * localFactor);
      g = Math.round(blue.g + (lightBlue.g - blue.g) * localFactor);
      b = Math.round(blue.b + (lightBlue.b - blue.b) * localFactor);
    } else {
      // Light blue to cyan
      const localFactor = (factor - 0.66) / 0.34;
      r = Math.round(lightBlue.r + (cyan.r - lightBlue.r) * localFactor);
      g = Math.round(lightBlue.g + (cyan.g - lightBlue.g) * localFactor);
      b = Math.round(lightBlue.b + (cyan.b - lightBlue.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate Autumn palette (warm colors: reds, oranges, yellows, browns)
function generateAutumnPalette(numColors) {
  const colors = [];
  // Autumn palette goes from dark red through orange/yellow to brown
  const darkRed = { r: 139, g: 0, b: 0 };      // Dark red
  const red = { r: 255, g: 0, b: 0 };          // Red
  const orange = { r: 255, g: 165, b: 0 };     // Orange
  const yellow = { r: 255, g: 255, b: 0 };     // Yellow
  const brown = { r: 139, g: 69, b: 19 };      // Brown
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.25) {
      // Dark red to red
      const localFactor = factor / 0.25;
      r = Math.round(darkRed.r + (red.r - darkRed.r) * localFactor);
      g = Math.round(darkRed.g + (red.g - darkRed.g) * localFactor);
      b = Math.round(darkRed.b + (red.b - darkRed.b) * localFactor);
    } else if (factor <= 0.5) {
      // Red to orange
      const localFactor = (factor - 0.25) / 0.25;
      r = Math.round(red.r + (orange.r - red.r) * localFactor);
      g = Math.round(red.g + (orange.g - red.g) * localFactor);
      b = Math.round(red.b + (orange.b - red.b) * localFactor);
    } else if (factor <= 0.75) {
      // Orange to yellow
      const localFactor = (factor - 0.5) / 0.25;
      r = Math.round(orange.r + (yellow.r - orange.r) * localFactor);
      g = Math.round(orange.g + (yellow.g - orange.g) * localFactor);
      b = Math.round(orange.b + (yellow.b - orange.b) * localFactor);
    } else {
      // Yellow to brown
      const localFactor = (factor - 0.75) / 0.25;
      r = Math.round(yellow.r + (brown.r - yellow.r) * localFactor);
      g = Math.round(yellow.g + (brown.g - yellow.g) * localFactor);
      b = Math.round(yellow.b + (brown.b - yellow.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate Wistia palette (dark blue → blue → green → yellow)
function generateWistiaPalette(numColors) {
  const colors = [];
  // Wistia palette goes from dark blue through blue, green to yellow
  const darkBlue = { r: 4, g: 0, b: 88 };           // Very dark blue
  const blue = { r: 0, g: 68, b: 255 };             // Blue
  const cyan = { r: 0, g: 255, b: 255 };            // Cyan
  const green = { r: 0, g: 255, b: 0 };             // Green
  const yellow = { r: 255, g: 255, b: 0 };          // Yellow
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.25) {
      // Dark blue to blue
      const localFactor = factor / 0.25;
      r = Math.round(darkBlue.r + (blue.r - darkBlue.r) * localFactor);
      g = Math.round(darkBlue.g + (blue.g - darkBlue.g) * localFactor);
      b = Math.round(darkBlue.b + (blue.b - darkBlue.b) * localFactor);
    } else if (factor <= 0.5) {
      // Blue to cyan
      const localFactor = (factor - 0.25) / 0.25;
      r = Math.round(blue.r + (cyan.r - blue.r) * localFactor);
      g = Math.round(blue.g + (cyan.g - blue.g) * localFactor);
      b = Math.round(blue.b + (cyan.b - blue.b) * localFactor);
    } else if (factor <= 0.75) {
      // Cyan to green
      const localFactor = (factor - 0.5) / 0.25;
      r = Math.round(cyan.r + (green.r - cyan.r) * localFactor);
      g = Math.round(cyan.g + (green.g - cyan.g) * localFactor);
      b = Math.round(cyan.b + (green.b - cyan.b) * localFactor);
    } else {
      // Green to yellow
      const localFactor = (factor - 0.75) / 0.25;
      r = Math.round(green.r + (yellow.r - green.r) * localFactor);
      g = Math.round(green.g + (yellow.g - green.g) * localFactor);
      b = Math.round(green.b + (yellow.b - green.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate PiYG palette (Pink-Yellow-Green)
function generatePiYGPalette(numColors) {
  const colors = [];
  const pink = { r: 208, g: 28, b: 139 };      // Pink
  const purple = { r: 174, g: 104, b: 162 };    // Purple
  const yellow = { r: 247, g: 247, b: 247 };    // Light yellow/white
  const lightGreen = { r: 166, g: 219, b: 160 }; // Light green
  const green = { r: 77, g: 172, b: 38 };      // Green
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.5) {
      // Pink to yellow (through purple)
      const localFactor = factor * 2;
      if (localFactor <= 0.5) {
        const subFactor = localFactor * 2;
        r = Math.round(pink.r + (purple.r - pink.r) * subFactor);
        g = Math.round(pink.g + (purple.g - pink.g) * subFactor);
        b = Math.round(pink.b + (purple.b - pink.b) * subFactor);
      } else {
        const subFactor = (localFactor - 0.5) * 2;
        r = Math.round(purple.r + (yellow.r - purple.r) * subFactor);
        g = Math.round(purple.g + (yellow.g - purple.g) * subFactor);
        b = Math.round(purple.b + (yellow.b - purple.b) * subFactor);
      }
    } else {
      // Yellow to green
      const localFactor = (factor - 0.5) * 2;
      r = Math.round(yellow.r + (green.r - yellow.r) * localFactor);
      g = Math.round(yellow.g + (green.g - yellow.g) * localFactor);
      b = Math.round(yellow.b + (green.b - yellow.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate RdYlBu palette (Red-Yellow-Blue)
function generateRdYlBuPalette(numColors) {
  const colors = [];
  const red = { r: 215, g: 25, b: 28 };        // Red
  const orange = { r: 253, g: 174, b: 97 };    // Orange
  const yellow = { r: 255, g: 255, b: 191 };   // Yellow
  const lightBlue = { r: 171, g: 217, b: 233 }; // Light blue
  const blue = { r: 44, g: 123, b: 182 };      // Blue
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.25) {
      // Red to orange
      const localFactor = factor / 0.25;
      r = Math.round(red.r + (orange.r - red.r) * localFactor);
      g = Math.round(red.g + (orange.g - red.g) * localFactor);
      b = Math.round(red.b + (orange.b - red.b) * localFactor);
    } else if (factor <= 0.5) {
      // Orange to yellow
      const localFactor = (factor - 0.25) / 0.25;
      r = Math.round(orange.r + (yellow.r - orange.r) * localFactor);
      g = Math.round(orange.g + (yellow.g - orange.g) * localFactor);
      b = Math.round(orange.b + (yellow.b - orange.b) * localFactor);
    } else if (factor <= 0.75) {
      // Yellow to light blue
      const localFactor = (factor - 0.5) / 0.25;
      r = Math.round(yellow.r + (lightBlue.r - yellow.r) * localFactor);
      g = Math.round(yellow.g + (lightBlue.g - yellow.g) * localFactor);
      b = Math.round(yellow.b + (lightBlue.b - yellow.b) * localFactor);
    } else {
      // Light blue to blue
      const localFactor = (factor - 0.75) / 0.25;
      r = Math.round(lightBlue.r + (blue.r - lightBlue.r) * localFactor);
      g = Math.round(lightBlue.g + (blue.g - lightBlue.g) * localFactor);
      b = Math.round(lightBlue.b + (blue.b - lightBlue.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate Spectral palette (Red-Yellow-Blue-Green)
function generateSpectralPalette(numColors) {
  const colors = [];
  const red = { r: 158, g: 1, b: 66 };         // Dark red
  const orange = { r: 213, g: 62, b: 79 };     // Orange-red
  const yellow = { r: 254, g: 224, b: 139 };  // Yellow
  const lightGreen = { r: 230, g: 245, b: 152 }; // Light green
  const green = { r: 153, g: 213, b: 148 };   // Green
  const cyan = { r: 50, g: 136, b: 189 };     // Cyan-blue
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.2) {
      // Red to orange
      const localFactor = factor / 0.2;
      r = Math.round(red.r + (orange.r - red.r) * localFactor);
      g = Math.round(red.g + (orange.g - red.g) * localFactor);
      b = Math.round(red.b + (orange.b - red.b) * localFactor);
    } else if (factor <= 0.4) {
      // Orange to yellow
      const localFactor = (factor - 0.2) / 0.2;
      r = Math.round(orange.r + (yellow.r - orange.r) * localFactor);
      g = Math.round(orange.g + (yellow.g - orange.g) * localFactor);
      b = Math.round(orange.b + (yellow.b - orange.b) * localFactor);
    } else if (factor <= 0.6) {
      // Yellow to light green
      const localFactor = (factor - 0.4) / 0.2;
      r = Math.round(yellow.r + (lightGreen.r - yellow.r) * localFactor);
      g = Math.round(yellow.g + (lightGreen.g - yellow.g) * localFactor);
      b = Math.round(yellow.b + (lightGreen.b - yellow.b) * localFactor);
    } else if (factor <= 0.8) {
      // Light green to green
      const localFactor = (factor - 0.6) / 0.2;
      r = Math.round(lightGreen.r + (green.r - lightGreen.r) * localFactor);
      g = Math.round(lightGreen.g + (green.g - lightGreen.g) * localFactor);
      b = Math.round(lightGreen.b + (green.b - lightGreen.b) * localFactor);
    } else {
      // Green to cyan
      const localFactor = (factor - 0.8) / 0.2;
      r = Math.round(green.r + (cyan.r - green.r) * localFactor);
      g = Math.round(green.g + (cyan.g - green.g) * localFactor);
      b = Math.round(green.b + (cyan.b - green.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate RdYlGn palette (Red-Yellow-Green)
function generateRdYlGnPalette(numColors) {
  const colors = [];
  const red = { r: 215, g: 25, b: 28 };        // Red
  const orange = { r: 253, g: 174, b: 97 };    // Orange
  const yellow = { r: 255, g: 255, b: 192 };    // Yellow
  const lightGreen = { r: 166, g: 217, b: 106 }; // Light green
  const green = { r: 26, g: 152, b: 80 };      // Green
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.25) {
      // Red to orange
      const localFactor = factor / 0.25;
      r = Math.round(red.r + (orange.r - red.r) * localFactor);
      g = Math.round(red.g + (orange.g - red.g) * localFactor);
      b = Math.round(red.b + (orange.b - red.b) * localFactor);
    } else if (factor <= 0.5) {
      // Orange to yellow
      const localFactor = (factor - 0.25) / 0.25;
      r = Math.round(orange.r + (yellow.r - orange.r) * localFactor);
      g = Math.round(orange.g + (yellow.g - orange.g) * localFactor);
      b = Math.round(orange.b + (yellow.b - orange.b) * localFactor);
    } else if (factor <= 0.75) {
      // Yellow to light green
      const localFactor = (factor - 0.5) / 0.25;
      r = Math.round(yellow.r + (lightGreen.r - yellow.r) * localFactor);
      g = Math.round(yellow.g + (lightGreen.g - yellow.g) * localFactor);
      b = Math.round(yellow.b + (lightGreen.b - yellow.b) * localFactor);
    } else {
      // Light green to green
      const localFactor = (factor - 0.75) / 0.25;
      r = Math.round(lightGreen.r + (green.r - lightGreen.r) * localFactor);
      g = Math.round(lightGreen.g + (green.g - lightGreen.g) * localFactor);
      b = Math.round(lightGreen.b + (green.b - lightGreen.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate BrBG palette (Brown-Blue-Green)
function generateBrBGPalette(numColors) {
  const colors = [];
  const brown = { r: 84, g: 48, b: 5 };        // Brown
  const tan = { r: 140, g: 81, b: 10 };        // Tan
  const cream = { r: 216, g: 179, b: 101 };    // Cream
  const lightBlue = { r: 140, g: 150, b: 198 }; // Light blue
  const blue = { r: 1, g: 102, b: 94 };        // Blue-green
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.25) {
      // Brown to tan
      const localFactor = factor / 0.25;
      r = Math.round(brown.r + (tan.r - brown.r) * localFactor);
      g = Math.round(brown.g + (tan.g - brown.g) * localFactor);
      b = Math.round(brown.b + (tan.b - brown.b) * localFactor);
    } else if (factor <= 0.5) {
      // Tan to cream
      const localFactor = (factor - 0.25) / 0.25;
      r = Math.round(tan.r + (cream.r - tan.r) * localFactor);
      g = Math.round(tan.g + (cream.g - tan.g) * localFactor);
      b = Math.round(tan.b + (cream.b - tan.b) * localFactor);
    } else if (factor <= 0.75) {
      // Cream to light blue
      const localFactor = (factor - 0.5) / 0.25;
      r = Math.round(cream.r + (lightBlue.r - cream.r) * localFactor);
      g = Math.round(cream.g + (lightBlue.g - cream.g) * localFactor);
      b = Math.round(cream.b + (lightBlue.b - cream.b) * localFactor);
    } else {
      // Light blue to blue-green
      const localFactor = (factor - 0.75) / 0.25;
      r = Math.round(lightBlue.r + (blue.r - lightBlue.r) * localFactor);
      g = Math.round(lightBlue.g + (blue.g - lightBlue.g) * localFactor);
      b = Math.round(lightBlue.b + (blue.b - lightBlue.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate PuOr palette (Purple-Orange)
function generatePuOrPalette(numColors) {
  const colors = [];
  const purple = { r: 127, g: 59, b: 8 };      // Dark purple
  const lightPurple = { r: 179, g: 88, b: 6 }; // Light purple
  const cream = { r: 224, g: 130, b: 20 };     // Cream
  const orange = { r: 253, g: 184, b: 99 };    // Orange
  const lightOrange = { r: 254, g: 224, b: 182 }; // Light orange
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    let r, g, b;
    
    if (factor <= 0.25) {
      // Purple to light purple
      const localFactor = factor / 0.25;
      r = Math.round(purple.r + (lightPurple.r - purple.r) * localFactor);
      g = Math.round(purple.g + (lightPurple.g - purple.g) * localFactor);
      b = Math.round(purple.b + (lightPurple.b - purple.b) * localFactor);
    } else if (factor <= 0.5) {
      // Light purple to cream
      const localFactor = (factor - 0.25) / 0.25;
      r = Math.round(lightPurple.r + (cream.r - lightPurple.r) * localFactor);
      g = Math.round(lightPurple.g + (cream.g - lightPurple.g) * localFactor);
      b = Math.round(lightPurple.b + (cream.b - lightPurple.b) * localFactor);
    } else if (factor <= 0.75) {
      // Cream to orange
      const localFactor = (factor - 0.5) / 0.25;
      r = Math.round(cream.r + (orange.r - cream.r) * localFactor);
      g = Math.round(cream.g + (orange.g - cream.g) * localFactor);
      b = Math.round(cream.b + (orange.b - cream.b) * localFactor);
    } else {
      // Orange to light orange
      const localFactor = (factor - 0.75) / 0.25;
      r = Math.round(orange.r + (lightOrange.r - orange.r) * localFactor);
      g = Math.round(orange.g + (lightOrange.g - orange.g) * localFactor);
      b = Math.round(orange.b + (lightOrange.b - orange.b) * localFactor);
    }
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Generate Set2 palette (qualitative, but made sequential)
function generateSet2Palette(numColors) {
  const colors = [];
  const teal = { r: 102, g: 194, b: 165 };     // Teal
  const orange = { r: 252, g: 141, b: 98 };    // Orange
  const purple = { r: 141, g: 160, b: 203 };   // Purple
  const pink = { r: 231, g: 138, b: 195 };     // Pink
  const yellow = { r: 166, g: 216, b: 84 };    // Yellow
  const brown = { r: 255, g: 217, b: 47 };     // Brown-yellow
  const grey = { r: 229, g: 196, b: 148 };     // Grey
  
  const paletteColors = [teal, orange, purple, pink, yellow, brown, grey];
  
  for (let i = 0; i < numColors; i++) {
    const factor = i / (numColors - 1);
    const colorIdx = Math.floor(factor * (paletteColors.length - 1));
    const nextColorIdx = Math.min(colorIdx + 1, paletteColors.length - 1);
    const localFactor = (factor * (paletteColors.length - 1)) - colorIdx;
    
    const c1 = paletteColors[colorIdx];
    const c2 = paletteColors[nextColorIdx];
    
    const r = Math.round(c1.r + (c2.r - c1.r) * localFactor);
    const g = Math.round(c1.g + (c2.g - c1.g) * localFactor);
    const b = Math.round(c1.b + (c2.b - c1.b) * localFactor);
    
    colors.push(rgbToHex(r, g, b));
  }
  
  return colors;
}

// Calculate Jenks natural breaks for all modes
function calculateJenksBreaks(data) {
  const accommodatesValues = [];
  const listingCountValues = [];
  const priceValues = [];
  const hostSinceValues = [];
  
  data.features.forEach(feature => {
    const props = feature.properties;
    
    // Accommodates (Guest Capacity per Night)
    const accommodates = props.accommodates || 0;
    if (accommodates > 0) {
      accommodatesValues.push(accommodates);
    }
    
    // Listing count (Listings per Building)
    const listingCount = props.listing_count || 0;
    if (listingCount > 0) {
      listingCountValues.push(listingCount);
    }
      
    // Price (Cumulative Price per Night/ Building)
    const price = props.price || 0;
      if (price > 0) {
      priceValues.push(price);
    }
    
    // Host since (convert date to numeric - years since 2000)
    if (props.host_since) {
      try {
        const date = new Date(props.host_since);
        if (!isNaN(date.getTime())) {
          const yearsSince2000 = (date.getTime() - new Date('2000-01-01').getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          hostSinceValues.push(yearsSince2000);
        }
      } catch (e) {
        // Skip invalid dates
      }
    }
  });
  
  jenksBreaks = {
    accommodates: calculateJenksBreaksFromData(accommodatesValues, 10),
    listing_count: calculateJenksBreaksFromData(listingCountValues, 10),
    price: calculateJenksBreaksFromData(priceValues, 10),
    host_since: calculateJenksBreaksFromData(hostSinceValues, 10)
  };
  
  console.log('Jenks breaks calculated:', jenksBreaks);
}

// Get building style based on current color mode
function getBuildingStyle(feature) {
  // If neighborhoods are visible, return grey color for all buildings
  if (neighborhoodsVisible) {
    return {
      color: '#666666',
      weight: 1,
      opacity: 0.7,
      fillColor: '#999999',
      fillOpacity: 0.6
    };
  }
  
  const props = feature.properties;
  let value = null;
  
  switch (currentColorMode) {
    case 'accommodates':
      value = (props.accommodates && props.accommodates > 0) ? props.accommodates : null;
      break;
    case 'listing_count':
      value = (props.listing_count && props.listing_count > 0) ? props.listing_count : null;
      break;
    case 'price':
      value = (props.price && props.price > 0) ? props.price : null;
      break;
    case 'host_since':
      if (props.host_since) {
        try {
          const date = new Date(props.host_since);
          if (!isNaN(date.getTime())) {
            value = (date.getTime() - new Date('2000-01-01').getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          }
        } catch (e) {
          value = null;
        }
      }
      break;
  }
  
  // Choose palette based on mode
  let palette;
  if (currentColorMode === 'accommodates') {
    palette = generateCoolPalette(10); // Cool palette for accommodates
  } else if (currentColorMode === 'price') {
    palette = generateAutumnPalette(10); // Autumn palette for price
  } else if (currentColorMode === 'host_since') {
    palette = generateWistiaPalette(10); // Wistia palette for host_since
  } else {
    palette = generateSpringRPalette(10); // Spring_r palette for others
  }
  
  const breaks = jenksBreaks[currentColorMode] || [];
  const fillColor = getColorForValue(value, breaks, palette);
  
  return {
    color: '#666666',
    weight: 1,
    opacity: 0.7,
    fillColor: fillColor,
    fillOpacity: 0.6
  };
}

// Update building colors
function updateBuildingColors() {
  if (!buildingsLayer) {
    console.warn('buildingsLayer is null');
    return;
  }
  
  console.log(`Updating building colors for mode: ${currentColorMode}`);
  console.log(`Jenks breaks for ${currentColorMode}:`, jenksBreaks[currentColorMode]);
  
  let updatedCount = 0;
  
  buildingsLayer.eachLayer(layer => {
    if (!layer.feature) {
      console.warn('Layer missing feature');
      return;
    }
    
    const feature = layer.feature;
    const style = getBuildingStyle(feature);
    
    // Force style update
    layer.setStyle(style);
    
    // Also update the path directly if it exists
    if (layer._path) {
      layer._path.setAttribute('fill', style.fillColor);
      layer._path.setAttribute('fill-opacity', style.fillOpacity);
      layer._path.setAttribute('stroke', style.color);
      layer._path.setAttribute('stroke-opacity', style.opacity);
    }
    
    updatedCount++;
  });
  
  // Force redraw
  if (buildingsLayer._renderer && buildingsLayer._renderer._updateStyle) {
    buildingsLayer._renderer._updateStyle(buildingsLayer);
  }
  
  console.log(`Updated ${updatedCount} building layers`);
}

// Calculate distribution for pie chart
function calculateDistribution(data) {
  const breaks = jenksBreaks[currentColorMode] || [];
  if (breaks.length < 2) return { distribution: [], noDataCount: 0, totalValue: 0, guestCounts: [], listingTotals: [], priceTotals: [], priceGuestCounts: [] };
  
  const distribution = new Array(breaks.length - 1).fill(0);
  const guestCounts = new Array(breaks.length - 1).fill(0); // For accommodates mode: total guests per class
  const listingTotals = new Array(breaks.length - 1).fill(0); // For listing_count mode: total listings per class
  const priceTotals = new Array(breaks.length - 1).fill(0); // For price mode: total price per class
  const priceGuestCounts = new Array(breaks.length - 1).fill(0); // For price mode: total guests per class
  let noDataCount = 0;
  let totalValue = 0;
  
  data.features.forEach(feature => {
    const props = feature.properties;
    let value = null;
    
    switch (currentColorMode) {
      case 'accommodates':
        value = (props.accommodates && props.accommodates > 0) ? props.accommodates : null;
        break;
      case 'listing_count':
        value = (props.listing_count && props.listing_count > 0) ? props.listing_count : null;
        break;
      case 'price':
        value = (props.price && props.price > 0) ? props.price : null;
        break;
      case 'host_since':
        if (props.host_since) {
          try {
            const date = new Date(props.host_since);
            if (!isNaN(date.getTime())) {
              value = (date.getTime() - new Date('2000-01-01').getTime()) / (1000 * 60 * 60 * 24 * 365.25);
            }
          } catch (e) {
            value = null;
          }
        }
        break;
    }
    
    if (value === null || value === undefined || isNaN(value)) {
      noDataCount++;
      return;
    }
    
    // For accommodates mode, sum up total guests
    if (currentColorMode === 'accommodates') {
      const listingCount = props.listing_count || 0;
      totalValue += value * listingCount; // Total guests = accommodates * number of listings
    }
    
    // For listing_count mode, sum up total listings
    if (currentColorMode === 'listing_count') {
      totalValue += value; // Total listings = sum of all listing_count values
    }
    
    // For price mode, sum up total price
    if (currentColorMode === 'price') {
      totalValue += value; // Total price = sum of all prices
    }
    
    // Find which class the value belongs to
    for (let i = 0; i < breaks.length - 1; i++) {
      if (value <= breaks[i + 1]) {
        distribution[i]++;
        // For accommodates mode, also track total guests in this class
        if (currentColorMode === 'accommodates') {
          const listingCount = props.listing_count || 0;
          guestCounts[i] += value * listingCount;
        }
        // For listing_count mode, track total listings in this class
        if (currentColorMode === 'listing_count') {
          listingTotals[i] += value; // value is already the listing_count
        }
        // For price mode, track total price and guests in this class
        if (currentColorMode === 'price') {
          priceTotals[i] += value;
          const accommodates = props.accommodates || 0;
          const listingCount = props.listing_count || 0;
          priceGuestCounts[i] += accommodates * listingCount; // Total guests = accommodates * listings
        }
        return;
      }
    }
    // If value is greater than last break, put it in the last class
    distribution[distribution.length - 1]++;
    if (currentColorMode === 'accommodates') {
      const listingCount = props.listing_count || 0;
      guestCounts[distribution.length - 1] += value * listingCount;
    }
    if (currentColorMode === 'listing_count') {
      listingTotals[distribution.length - 1] += value;
    }
    if (currentColorMode === 'price') {
      priceTotals[distribution.length - 1] += value;
      const accommodates = props.accommodates || 0;
      const listingCount = props.listing_count || 0;
      priceGuestCounts[distribution.length - 1] += accommodates * listingCount;
    }
  });
  
  return { distribution, noDataCount, totalValue, guestCounts, listingTotals, priceTotals, priceGuestCounts };
}

// Create donut chart SVG
function createPieChart(distribution, noDataCount, palette, breaks, totalBuildings, centerText = null, guestCounts = null, listingTotals = null, priceTotals = null, priceGuestCounts = null) {
  const size = 100;
  const outerRadius = size / 2 - 5;
  const innerRadius = outerRadius * 0.5; // Inner radius for donut hole
  const centerX = size / 2;
  const centerY = size / 2;
  
  const total = distribution.reduce((a, b) => a + b, 0) + noDataCount;
  if (total === 0) return '<div style="color: #999; font-size: 10px;">No data</div>';
  
  let currentAngle = -Math.PI / 2; // Start at top
  let svg = `<svg width="${size}" height="${size}" style="display: block; margin: 0 auto;">
    <defs>
      <style>
        .pie-segment { cursor: pointer; }
        .pie-segment:hover { opacity: 0.8; }
      </style>
    </defs>`;
  
  // Draw segments for each class
  distribution.forEach((count, i) => {
    if (count === 0) return;
    
    const angle = (count / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    
    // Outer arc coordinates
    const outerX1 = centerX + outerRadius * Math.cos(startAngle);
    const outerY1 = centerY + outerRadius * Math.sin(startAngle);
    const outerX2 = centerX + outerRadius * Math.cos(endAngle);
    const outerY2 = centerY + outerRadius * Math.sin(endAngle);
    
    // Inner arc coordinates
    const innerX1 = centerX + innerRadius * Math.cos(startAngle);
    const innerY1 = centerY + innerRadius * Math.sin(startAngle);
    const innerX2 = centerX + innerRadius * Math.cos(endAngle);
    const innerY2 = centerY + innerRadius * Math.sin(endAngle);
    
    const largeArc = angle > Math.PI ? 1 : 0;
    
    const color = palette[i] || '#999999';
    
    // Calculate range for this segment
    const rangeStart = breaks[i];
    const rangeEnd = breaks[i + 1];
    const rangeStartInt = Math.ceil(rangeStart);
    const rangeEndInt = Math.ceil(rangeEnd);
    
    // Format range text based on current color mode
    let rangeText;
    if (currentColorMode === 'host_since') {
      // For host_since mode, convert years since 2000 to actual years (add 2000)
      const startYear = 2000 + rangeStartInt;
      const endYear = 2000 + rangeEndInt;
      rangeText = `${startYear}-${endYear}`;
    } else {
      rangeText = `${rangeStartInt}-${rangeEndInt}`;
    }
    
    // Add guest count data attribute if in accommodates mode
    const guestCountAttr = guestCounts && guestCounts[i] ? `data-guest-count="${Math.round(guestCounts[i])}"` : '';
    // Add listing total data attribute if in listing_count mode
    const listingTotalAttr = listingTotals && listingTotals[i] ? `data-listing-total="${Math.round(listingTotals[i])}"` : '';
    // Add price total data attribute if in price mode
    const priceTotalAttr = priceTotals && priceTotals[i] ? `data-price-total="${Math.round(priceTotals[i])}"` : '';
    // Add price guest count data attribute if in price mode
    const priceGuestCountAttr = priceGuestCounts && priceGuestCounts[i] ? `data-price-guest-count="${Math.round(priceGuestCounts[i])}"` : '';
    
    // Create donut segment path with hover tooltip data
    svg += `<path class="pie-segment" data-count="${count}" data-range="${rangeText}" data-index="${i}" ${guestCountAttr} ${listingTotalAttr} ${priceTotalAttr} ${priceGuestCountAttr} d="M ${outerX1} ${outerY1} 
      A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerX2} ${outerY2}
      L ${innerX2} ${innerY2}
      A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerX1} ${innerY1}
      Z" 
      fill="${color}" stroke="#333" stroke-width="0.5"/>`;
    
    currentAngle = endAngle;
  });
  
  // Draw no data segment if exists
  if (noDataCount > 0) {
    const angle = (noDataCount / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    
    // Outer arc coordinates
    const outerX1 = centerX + outerRadius * Math.cos(startAngle);
    const outerY1 = centerY + outerRadius * Math.sin(startAngle);
    const outerX2 = centerX + outerRadius * Math.cos(endAngle);
    const outerY2 = centerY + outerRadius * Math.sin(endAngle);
    
    // Inner arc coordinates
    const innerX1 = centerX + innerRadius * Math.cos(startAngle);
    const innerY1 = centerY + innerRadius * Math.sin(startAngle);
    const innerX2 = centerX + innerRadius * Math.cos(endAngle);
    const innerY2 = centerY + innerRadius * Math.sin(endAngle);
    
    const largeArc = angle > Math.PI ? 1 : 0;
    
    svg += `<path class="pie-segment" data-count="${noDataCount}" data-range="No data" d="M ${outerX1} ${outerY1} 
      A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerX2} ${outerY2}
      L ${innerX2} ${innerY2}
      A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerX1} ${innerY1}
      Z" 
      fill="#999999" stroke="#333" stroke-width="0.5"/>`;
  }
  
  // Add center text in the donut hole
  if (centerText) {
    // Handle both string (with €) and number values
    const valueDisplay = typeof centerText.value === 'string' 
      ? centerText.value 
      : centerText.value.toLocaleString();
    svg += `
      <text x="${centerX}" y="${centerY - 5}" text-anchor="middle" fill="white" font-size="12px" font-weight="bold" style="pointer-events: none;">
        ${valueDisplay}
      </text>
      <text x="${centerX}" y="${centerY + 8}" text-anchor="middle" fill="#ccc" font-size="9px" style="pointer-events: none;">
        ${centerText.label}
      </text>
    `;
  } else {
    svg += `
      <text x="${centerX}" y="${centerY - 5}" text-anchor="middle" fill="white" font-size="12px" font-weight="bold" style="pointer-events: none;">
        ${totalBuildings.toLocaleString()}
      </text>
      <text x="${centerX}" y="${centerY + 8}" text-anchor="middle" fill="#ccc" font-size="9px" style="pointer-events: none;">
        buildings
      </text>
    `;
  }
  
  svg += '</svg>';
  return svg;
}

// Get legend title based on current color mode
function getLegendTitle() {
  switch (currentColorMode) {
    case 'accommodates':
      return 'Number of Buildings with Guest Capacity per Night';
    case 'listing_count':
      return 'Listings per Building';
    case 'price':
      return 'Cumulative Price per Night/ Building';
    case 'host_since':
      return 'Since';
    default:
      return 'Listings per Building';
  }
}

// Update legend display
function updateLegend() {
  const legendDiv = document.getElementById('color-legend');
  if (!legendDiv) {
    console.warn('Legend div not found');
    return;
  }
  
  const breaks = jenksBreaks[currentColorMode] || [];
  console.log(`Updating legend for ${currentColorMode}, breaks:`, breaks);
  
  if (breaks.length < 2 || !buildingsData) {
    legendDiv.innerHTML = '<div style="color: #999; font-size: 10px;">No data</div>';
    return;
  }
  
  // Choose palette based on mode
  let palette;
  if (currentColorMode === 'accommodates') {
    palette = generateCoolPalette(10); // Cool palette for accommodates
  } else if (currentColorMode === 'price') {
    palette = generateAutumnPalette(10); // Autumn palette for price
  } else if (currentColorMode === 'host_since') {
    palette = generateWistiaPalette(10); // Wistia palette for host_since
  } else {
    palette = generateSpringRPalette(10); // Spring_r palette for others
  }
  
  console.log(`Generated palette with ${palette.length} colors:`, palette);
  
  // Calculate distribution to get counts per range
  const { distribution, noDataCount } = calculateDistribution(buildingsData);
  
  const legendContent = generateLegendContent(breaks, distribution, noDataCount, palette);
  
  let legendHTML = `
    <div style="font-size: 10px; font-weight: bold; margin-bottom: 4px;">${getLegendTitle()}</div>
    ${legendContent}
  `;
  
  legendDiv.innerHTML = legendHTML;
  
  console.log('Legend updated successfully');
}

// Generate legend content HTML
function generateLegendContent(breaks, distribution, noDataCount, palette) {
  let legendHTML = '';
  
  // Create legend items for each class (from highest to lowest)
  const numClasses = breaks.length - 1;
  
  for (let i = numClasses - 1; i >= 0; i--) {
    const colorIndex = Math.min(i, palette.length - 1);
    const color = palette[colorIndex];
    
    const rangeStart = breaks[i];
    const rangeEnd = breaks[i + 1];
    
    const rangeStartInt = Math.ceil(rangeStart);
    const rangeEndInt = Math.ceil(rangeEnd);
    
    // Format range text based on mode
    let rangeText;
    if (currentColorMode === 'price') {
      // Add € symbol for price mode ranges
      rangeText = `€${rangeStartInt.toLocaleString()}-€${rangeEndInt.toLocaleString()}`;
    } else if (currentColorMode === 'host_since') {
      // For host_since mode, convert years since 2000 to actual years (add 2000)
      const startYear = 2000 + rangeStartInt;
      const endYear = 2000 + rangeEndInt;
      rangeText = `${startYear}-${endYear}`;
    } else {
      rangeText = `${rangeStartInt}-${rangeEndInt}`;
    }
    const count = distribution[i] || 0;
    
    legendHTML += `
      <div style="display: flex; align-items: center; margin: 1px 0;">
        <div style="width: 20px; height: 12px; background: ${color}; border: 1px solid #333; margin-right: 6px;"></div>
        <div style="font-size: 10px; color: white;">${rangeText} - ${count}</div>
      </div>
    `;
  }
  
  if (noDataCount > 0) {
  legendHTML += `
    <div style="display: flex; align-items: center; margin-top: 4px; padding-top: 4px; border-top: 1px solid #555;">
      <div style="width: 20px; height: 12px; background: #999999; border: 1px solid #333; margin-right: 6px;"></div>
        <div style="font-size: 10px; color: #999;">No data - ${noDataCount}</div>
    </div>
  `;
  }
  
  return legendHTML;
}

// Update pie chart
function updatePieChart() {
  const pieChartDiv = document.getElementById('pie-chart');
  if (!pieChartDiv || !buildingsData) {
    return;
  }
  
  const breaks = jenksBreaks[currentColorMode] || [];
  if (breaks.length < 2) {
    pieChartDiv.innerHTML = '<div style="color: #999; font-size: 10px;">No data</div>';
    return;
  }
  
  const { distribution, noDataCount, totalValue, guestCounts, listingTotals, priceTotals, priceGuestCounts } = calculateDistribution(buildingsData);
  
  // Choose palette based on mode
  let palette;
  if (currentColorMode === 'accommodates') {
    palette = generateCoolPalette(10); // Cool palette for accommodates
  } else if (currentColorMode === 'price') {
    palette = generateAutumnPalette(10); // Autumn palette for price
  } else if (currentColorMode === 'host_since') {
    palette = generateWistiaPalette(10); // Wistia palette for host_since
  } else {
    palette = generateSpringRPalette(10); // Spring_r palette for others
  }
  
  const totalBuildings = distribution.reduce((a, b) => a + b, 0) + noDataCount;
  
  // Set center text based on mode
  let centerText = null;
  if (currentColorMode === 'accommodates' && totalValue > 0) {
    centerText = { value: Math.round(totalValue), label: 'guests' };
  } else if (currentColorMode === 'listing_count' && totalValue > 0) {
    centerText = { value: Math.round(totalValue).toLocaleString(), label: 'listings' };
  } else if (currentColorMode === 'price' && totalValue > 0) {
    // Round up to 2 decimal places (millions)
    const totalInMillions = Math.ceil((totalValue / 1000000) * 100) / 100;
    centerText = { value: `€${totalInMillions.toFixed(2)}mln`, label: 'Total' };
  }
  
  const pieChartSVG = createPieChart(distribution, noDataCount, palette, breaks, totalBuildings, centerText, guestCounts, listingTotals, priceTotals, priceGuestCounts);
  
  pieChartDiv.innerHTML = `
    <div style="position: relative;">
      ${pieChartSVG}
      <div id="pie-tooltip" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); 
        background: rgba(0,0,0,0.9); color: white; padding: 4px 8px; border-radius: 3px; 
        font-size: 11px; font-weight: bold; pointer-events: none; opacity: 0; transition: opacity 0.2s;
        white-space: nowrap; z-index: 1000; text-align: center; line-height: 1.4;">
      </div>
    </div>
  `;
  
  // Add hover event listeners to pie segments
  setTimeout(() => {
    const pieChartContainer = pieChartDiv.querySelector('svg');
    if (pieChartContainer) {
      const segments = pieChartContainer.querySelectorAll('.pie-segment');
      const tooltip = document.getElementById('pie-tooltip');
      
      segments.forEach(segment => {
        segment.addEventListener('mouseenter', function(e) {
          const count = this.getAttribute('data-count');
          const range = this.getAttribute('data-range');
          const guestCount = this.getAttribute('data-guest-count');
          const listingTotal = this.getAttribute('data-listing-total');
          const priceTotal = this.getAttribute('data-price-total');
          if (tooltip && count) {
            // For accommodates mode, show guest count instead of building count
            if (currentColorMode === 'accommodates' && guestCount) {
              tooltip.innerHTML = `<div>${range}</div><div style="font-size: 10px; opacity: 0.9;">${parseInt(guestCount).toLocaleString()} guests</div>`;
            } else if (currentColorMode === 'listing_count' && listingTotal) {
              // For listing_count mode, show number of listings
              tooltip.innerHTML = `<div>${range}</div><div style="font-size: 10px; opacity: 0.9;">${parseInt(listingTotal).toLocaleString()} listings</div>`;
            } else if (currentColorMode === 'price' && priceTotal) {
              // For price mode, show guest count above and total price per segment with € symbol
              const priceGuestCount = this.getAttribute('data-price-guest-count');
              let tooltipContent = '';
              if (priceGuestCount) {
                tooltipContent += `<div style="font-size: 10px; opacity: 0.9;">${parseInt(priceGuestCount).toLocaleString()} guests</div>`;
              }
              tooltipContent += `<div style="font-size: 10px; opacity: 0.9;">€${parseInt(priceTotal).toLocaleString()}</div>`;
              tooltip.innerHTML = tooltipContent;
            } else {
              tooltip.innerHTML = `<div>${range}</div><div style="font-size: 10px; opacity: 0.9;">${count} buildings</div>`;
            }
            tooltip.style.opacity = '1';
          }
        });
        
        segment.addEventListener('mouseleave', function(e) {
          if (tooltip) {
            tooltip.style.opacity = '0';
          }
        });
      });
    }
  }, 100);
}

// Create dashboard
function createDashboard() {
  const dashboard = L.control({ position: 'topright' });
  
  dashboard.onAdd = function(map) {
    const div = L.DomUtil.create('div', 'airbnb-dashboard');
    div.style.cssText = 'position: absolute; top: 5px; right: 5px; background: rgba(0,0,0,0.8); color: white; padding: 10px; border-radius: 5px; font-family: sans-serif; font-size: 12px; z-index: 1000; display: flex; flex-direction: column;';
    
    // Create header with minimize/maximize button
    const header = L.DomUtil.create('div', 'dashboard-header');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
    
    const title = L.DomUtil.create('div', 'dashboard-title');
    title.style.cssText = 'font-size: 12px; font-weight: bold;';
    title.textContent = 'Airbnb Analytics';
    header.appendChild(title);
    
    const toggleBtn = L.DomUtil.create('button', 'dashboard-toggle-btn');
    toggleBtn.textContent = '−';
    toggleBtn.style.cssText = 'background: transparent; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;';
    header.appendChild(toggleBtn);
    
    div.appendChild(header);
    
    // Create content container
    const contentContainer = L.DomUtil.create('div', 'dashboard-content');
    contentContainer.id = 'dashboard-content';
    
    // Create button container for mode selection
    const buttonContainer = L.DomUtil.create('div', 'mode-buttons-container');
    buttonContainer.style.cssText = 'display: flex; gap: 6px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #555;';
    
    // Create 4 round buttons
    const buttonConfigs = [
      { color: '#a05eeb', hoverText: 'Guest Capacity per Night', mode: 'accommodates' },
      { color: '#ff4444', hoverText: 'Listings per Building', mode: 'listing_count', active: true },
      { color: '#ff8800', hoverText: 'Cumulative Price per Night/ Building', mode: 'price' },
      { color: '#ffcc00', hoverText: 'Since', mode: 'host_since' }
    ];
    
    buttonConfigs.forEach(config => {
      const button = L.DomUtil.create('button', 'mode-button');
      button.style.cssText = `
        flex: 1;
        width: 100%;
        height: 30px;
        border-radius: 15px;
        border: 2px solid ${config.active ? '#fff' : '#666'};
        background: ${config.color};
        cursor: pointer;
        position: relative;
        transition: all 0.2s;
      `;
      
      if (config.active) {
        button.style.boxShadow = '0 0 8px rgba(255,255,255,0.5)';
      }
      
      // Create tooltip element
      const tooltip = L.DomUtil.create('div', 'mode-button-tooltip');
      tooltip.textContent = config.hoverText;
      tooltip.style.cssText = `
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.9);
        color: white;
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 10px;
        white-space: nowrap;
        margin-bottom: 5px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
        z-index: 1001;
      `;
      button.appendChild(tooltip);
      
      // Add hover events
      button.addEventListener('mouseenter', function() {
        tooltip.style.opacity = '1';
        if (!config.active) {
          button.style.borderColor = '#fff';
          button.style.opacity = '0.9';
        }
      });
      
      button.addEventListener('mouseleave', function() {
        tooltip.style.opacity = '0';
        if (!config.active) {
          button.style.borderColor = '#666';
          button.style.opacity = '1';
        }
      });
      
      // Add click handler to switch modes
      button.addEventListener('click', function() {
        // Update current color mode
        currentColorMode = config.mode;
        
        // Update button states
        buttonConfigs.forEach((btnConfig, idx) => {
          const btn = buttonContainer.children[idx];
          if (btnConfig.mode === config.mode) {
            btnConfig.active = true;
            btn.style.borderColor = '#fff';
            btn.style.boxShadow = '0 0 8px rgba(255,255,255,0.5)';
          } else {
            btnConfig.active = false;
            btn.style.borderColor = '#666';
            btn.style.boxShadow = 'none';
          }
        });
        
        // Update buildings, legend, and pie chart
        updateBuildingColors();
        updateLegend();
        updatePieChart();
      });
      
      buttonContainer.appendChild(button);
    });
    
    // Create legend container
    const legendContainer = L.DomUtil.create('div', 'legend-container');
    legendContainer.style.cssText = 'margin-bottom: 10px;';
    
    const legendDiv = L.DomUtil.create('div', 'color-legend');
    legendDiv.id = 'color-legend';
    legendDiv.style.cssText = 'min-width: 80px;';
    legendContainer.appendChild(legendDiv);
    
    contentContainer.appendChild(buttonContainer);
    
    // Create pie chart container
    const pieChartContainer = L.DomUtil.create('div', 'pie-chart-container');
    pieChartContainer.style.cssText = 'margin-top: 10px; padding-top: 10px; border-top: 1px solid #555;';
    
    const pieChartDiv = L.DomUtil.create('div', 'pie-chart');
    pieChartDiv.id = 'pie-chart';
    pieChartDiv.style.cssText = 'min-width: 100px;';
    pieChartContainer.appendChild(pieChartDiv);
    
    contentContainer.appendChild(legendContainer);
    contentContainer.appendChild(pieChartContainer);
    div.appendChild(contentContainer);
    
    // Add minimize/maximize functionality
    L.DomEvent.on(toggleBtn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      const isMinimized = contentContainer.style.display === 'none';
      if (isMinimized) {
        contentContainer.style.display = '';
        toggleBtn.textContent = '−';
      } else {
        contentContainer.style.display = 'none';
        toggleBtn.textContent = '□';
      }
    });
    
    // Add event listeners
    L.DomEvent.disableClickPropagation(div);
    
    setTimeout(() => {
      // Initial legend and pie chart update
        updateLegend();
      updatePieChart();
    }, 100);
    
    return div;
  };
  
  dashboard.addTo(map);
}

// Create neighborhood legend with show/hide buttons
function createNeighborhoodLegend() {
  const neighborhoodControl = L.control({ position: 'topright' });
  
  neighborhoodControl.onAdd = function(map) {
    const div = L.DomUtil.create('div', 'neighborhood-legend');
    div.style.cssText = 'position: absolute; top: 5px; right: 220px; background: rgba(0,0,0,0.8); color: white; padding: 10px; border-radius: 5px; font-family: sans-serif; font-size: 12px; z-index: 1000; width: 200px;';
    
    // Create title with minimize/maximize button
    const titleContainer = L.DomUtil.create('div', 'neighborhood-title-container');
    titleContainer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
    
    const title = L.DomUtil.create('div', 'neighborhood-title');
    title.style.cssText = 'font-weight: bold; font-size: 14px;';
    title.textContent = 'neighborhoods and towns of Venice commune';
    titleContainer.appendChild(title);
    
    const toggleBtn = L.DomUtil.create('button', 'neighborhood-toggle-btn');
    toggleBtn.textContent = '−';
    toggleBtn.style.cssText = 'background: transparent; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;';
    titleContainer.appendChild(toggleBtn);
    
    div.appendChild(titleContainer);
    
    // Create content container
    const contentContainer = L.DomUtil.create('div', 'neighborhood-content');
    contentContainer.id = 'neighborhood-content';
    
    // Create button container
    const buttonContainer = L.DomUtil.create('div', 'neighborhood-buttons');
    buttonContainer.style.cssText = 'display: flex; gap: 6px; margin-top: 8px;';
    
    // Create Show button
    const showButton = L.DomUtil.create('button', 'neighborhood-show-btn');
    showButton.textContent = 'Show';
    showButton.style.cssText = 'flex: 1; padding: 6px 12px; background: #555; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: bold;';
    
    // Create Hide button
    const hideButton = L.DomUtil.create('button', 'neighborhood-hide-btn');
    hideButton.textContent = 'Hide';
    hideButton.style.cssText = 'flex: 1; padding: 6px 12px; background: #4169E1; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: bold;';
    
    buttonContainer.appendChild(showButton);
    buttonContainer.appendChild(hideButton);
    contentContainer.appendChild(buttonContainer);
    
    // Create classification buttons container
    const classificationContainer = L.DomUtil.create('div', 'neighborhood-classification-buttons');
    classificationContainer.style.cssText = 'display: flex; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid #555; flex-wrap: wrap;';
    
    // Define 7 classification buttons with colors from green to dark blue
    const classificationConfigs = [
      { key: 'listings_total', hoverText: 'listings_total', color: '#00FF00', palette: 'PiYG' },
      { key: 'total_guests_per_night', hoverText: 'total_guests_per_night', color: '#00CC66', palette: 'RdYlBu' },
      { key: 'guest_night_capacity_per_year', hoverText: 'guest_night_capacity_per_year', color: '#00CCCC', palette: 'Spectral' },
      { key: 'total_price_per_night', hoverText: 'total_price_per_night', color: '#0099CC', palette: 'RdYlGn' },
      { key: 'median_price_per_unit', hoverText: 'median_price_per_unit', color: '#0066CC', palette: 'BrBG' },
      { key: 'max_price_per_unit', hoverText: 'max_price_per_unit', color: '#0033CC', palette: 'PuOr' },
      { key: 'min_price_per_unit', hoverText: 'min_price_per_unit', color: '#0000CC', palette: 'Set2' }
    ];
    
    classificationConfigs.forEach(config => {
      const button = L.DomUtil.create('button', 'neighborhood-classification-btn');
      button.style.cssText = `
        flex: 1;
        min-width: 20px;
        height: 20px;
        border-radius: 10px;
        border: 2px solid #666;
        background: ${config.color};
        cursor: pointer;
        position: relative;
        transition: all 0.2s;
      `;
      
      // Create tooltip element
      const tooltip = L.DomUtil.create('div', 'classification-button-tooltip');
      tooltip.textContent = config.hoverText;
      tooltip.style.cssText = `
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.9);
        color: white;
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 10px;
        white-space: nowrap;
        margin-bottom: 5px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
        z-index: 1001;
      `;
      button.appendChild(tooltip);
      
      // Add hover events
      button.addEventListener('mouseenter', function() {
        tooltip.style.opacity = '1';
        if (neighborhoodClassificationKey !== config.key) {
          button.style.borderColor = '#fff';
          button.style.opacity = '0.9';
        }
      });
      
      button.addEventListener('mouseleave', function() {
        tooltip.style.opacity = '0';
        if (neighborhoodClassificationKey !== config.key) {
          button.style.borderColor = '#666';
          button.style.opacity = '1';
        }
      });
      
      // Add click handler
      button.addEventListener('click', function() {
        // Toggle classification
        if (neighborhoodClassificationKey === config.key) {
          // Deselect
          neighborhoodClassificationKey = null;
          button.style.borderColor = '#666';
          button.style.boxShadow = 'none';
        } else {
          // Select this classification
          neighborhoodClassificationKey = config.key;
          
          // Update all button states
          classificationConfigs.forEach((btnConfig, idx) => {
            const btn = classificationContainer.children[idx];
            if (btnConfig.key === config.key) {
              btn.style.borderColor = '#fff';
              btn.style.boxShadow = '0 0 8px rgba(255,255,255,0.5)';
            } else {
              btn.style.borderColor = '#666';
              btn.style.boxShadow = 'none';
            }
          });
        }
        
        // Update neighborhood colors
        updateNeighborhoodColors();
        
        // Update classification info display
        updateNeighborhoodClassificationInfo();
      });
      
      classificationContainer.appendChild(button);
    });
    
    contentContainer.appendChild(classificationContainer);
    
    // Create classification info container (name, legend, total)
    const classificationInfoContainer = L.DomUtil.create('div', 'neighborhood-classification-info');
    classificationInfoContainer.id = 'neighborhood-classification-info';
    classificationInfoContainer.style.cssText = 'margin-top: 10px; padding-top: 10px; border-top: 1px solid #555; display: none;';
    
    // Classification name
    const classificationNameDiv = L.DomUtil.create('div', 'neighborhood-classification-name');
    classificationNameDiv.id = 'neighborhood-classification-name';
    classificationNameDiv.style.cssText = 'font-weight: bold; font-size: 11px; margin-bottom: 8px; color: #fff;';
    classificationInfoContainer.appendChild(classificationNameDiv);
    
    // Color legend
    const neighborhoodLegendDiv = L.DomUtil.create('div', 'neighborhood-color-legend');
    neighborhoodLegendDiv.id = 'neighborhood-color-legend';
    neighborhoodLegendDiv.style.cssText = 'margin-bottom: 8px;';
    classificationInfoContainer.appendChild(neighborhoodLegendDiv);
    
    // Total value
    const neighborhoodTotalDiv = L.DomUtil.create('div', 'neighborhood-total');
    neighborhoodTotalDiv.id = 'neighborhood-total';
    neighborhoodTotalDiv.style.cssText = 'font-size: 11px; font-weight: bold; color: #fff; text-align: center; padding-top: 8px; border-top: 1px solid #555;';
    classificationInfoContainer.appendChild(neighborhoodTotalDiv);
    
    contentContainer.appendChild(classificationInfoContainer);
    div.appendChild(contentContainer);
    
    // Function to update neighborhood classification info
    function updateNeighborhoodClassificationInfo() {
      const infoContainer = document.getElementById('neighborhood-classification-info');
      const nameDiv = document.getElementById('neighborhood-classification-name');
      const legendDiv = document.getElementById('neighborhood-color-legend');
      const totalDiv = document.getElementById('neighborhood-total');
      
      if (!neighborhoodClassificationKey || !neighborhoodGeoJSONData) {
        infoContainer.style.display = 'none';
        return;
      }
      
      infoContainer.style.display = 'block';
      
      // Find the config for this key
      const config = classificationConfigs.find(c => c.key === neighborhoodClassificationKey);
      if (config) {
        nameDiv.textContent = config.hoverText;
      }
      
      // Get breaks and palette
      const breaks = neighborhoodJenksBreaks[neighborhoodClassificationKey] || [];
      const paletteMap = {
        'listings_total': generatePiYGPalette(10),
        'total_guests_per_night': generateRdYlBuPalette(10),
        'guest_night_capacity_per_year': generateSpectralPalette(10),
        'total_price_per_night': generateRdYlGnPalette(10),
        'median_price_per_unit': generateBrBGPalette(10),
        'max_price_per_unit': generatePuOrPalette(10),
        'min_price_per_unit': generateSet2Palette(10)
      };
      const palette = paletteMap[neighborhoodClassificationKey] || generatePiYGPalette(10);
      
      // Generate legend HTML
      let legendHTML = '';
      const numClasses = breaks.length - 1;
      
      // Determine unit based on key
      let unit = '';
      let isPrice = false;
      if (neighborhoodClassificationKey.includes('price')) {
        unit = '€';
        isPrice = true;
      } else if (neighborhoodClassificationKey.includes('guests') || neighborhoodClassificationKey.includes('guest')) {
        unit = ' guests';
      } else if (neighborhoodClassificationKey === 'listings_total') {
        unit = ' listings';
      }
      
      for (let i = numClasses - 1; i >= 0; i--) {
        const colorIndex = Math.min(i, palette.length - 1);
        const color = palette[colorIndex];
        
        const rangeStart = breaks[i];
        const rangeEnd = breaks[i + 1];
        
        const rangeStartInt = Math.ceil(rangeStart);
        const rangeEndInt = Math.ceil(rangeEnd);
        
        let rangeText;
        if (isPrice) {
          rangeText = `€${rangeStartInt.toLocaleString()}-€${rangeEndInt.toLocaleString()}`;
      } else {
          rangeText = `${rangeStartInt.toLocaleString()}-${rangeEndInt.toLocaleString()}${unit}`;
        }
        
        legendHTML += `
          <div style="display: flex; align-items: center; margin-bottom: 3px; font-size: 9px;">
            <div style="width: 12px; height: 12px; background: ${color}; border: 1px solid #666; margin-right: 6px; flex-shrink: 0;"></div>
            <div style="flex: 1; color: #fff;">${rangeText}</div>
          </div>
        `;
      }
      
      legendDiv.innerHTML = legendHTML;
      
      // Calculate total or average based on key
      const averageKeys = ['median_price_per_unit', 'max_price_per_unit', 'min_price_per_unit'];
      const isAverageKey = averageKeys.includes(neighborhoodClassificationKey);
      
      let total = 0;
      let count = 0;
      neighborhoodGeoJSONData.features.forEach(feature => {
        const value = feature.properties[neighborhoodClassificationKey];
        if (value !== null && value !== undefined && !isNaN(value) && value > 0) {
          total += value;
          count++;
        }
      });
      
      let totalText;
      if (isAverageKey) {
        // Calculate average per night
        const average = count > 0 ? total / count : 0;
        totalText = `Average per Night: €${Math.round(average).toLocaleString()}`;
      } else if (isPrice) {
        totalText = `Total: €${total.toLocaleString()}`;
      } else {
        totalText = `Total: ${total.toLocaleString()}${unit}`;
      }
      totalDiv.textContent = totalText;
    }
    
    // Function to show neighborhoods
    function showNeighborhoods() {
      if (barriLayer) {
        map.addLayer(barriLayer);
        if (barriLabelsLayer) {
          map.addLayer(barriLabelsLayer);
        }
        showButton.style.background = '#4169E1';
        hideButton.style.background = '#555';
        
        // Turn all buildings grey
        neighborhoodsVisible = true;
        updateBuildingColors();
        
        // Remove neighborhood classification and restore initial color
        neighborhoodClassificationKey = null;
        classificationConfigs.forEach((btnConfig, idx) => {
          const btn = classificationContainer.children[idx];
          btn.style.borderColor = '#666';
          btn.style.boxShadow = 'none';
        });
        updateNeighborhoodColors();
        updateNeighborhoodClassificationInfo();
      }
    }
    
    // Function to hide neighborhoods
    function hideNeighborhoods() {
      if (barriLayer) {
        map.removeLayer(barriLayer);
        if (barriLabelsLayer) {
          map.removeLayer(barriLabelsLayer);
        }
        showButton.style.background = '#555';
        hideButton.style.background = '#4169E1';
        
        // Restore building colors
        neighborhoodsVisible = false;
        updateBuildingColors();
      }
    }
    
    // Hide neighborhoods by default
    hideNeighborhoods();
    
    // Add minimize/maximize functionality
    L.DomEvent.on(toggleBtn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      const isMinimized = contentContainer.style.display === 'none';
      if (isMinimized) {
        contentContainer.style.display = '';
        toggleBtn.textContent = '−';
      } else {
        contentContainer.style.display = 'none';
        toggleBtn.textContent = '□';
      }
    });
    
    // Add event listeners
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(showButton, 'click', showNeighborhoods);
    L.DomEvent.on(hideButton, 'click', hideNeighborhoods);
    
    return div;
  };
  
  neighborhoodControl.addTo(map);
}

// Load and display Airbnb buildings GeoJSON
async function loadAirbnbBuildingsGeoJSON() {
  try {
    const response = await fetch('/output/venice_airbnb_buildings.geojson');
    buildingsData = await response.json();
    
    // Calculate Jenks natural breaks
    calculateJenksBreaks(buildingsData);
    
    // Create GeoJSON layer with dynamic styling
    buildingsLayer = L.geoJSON(buildingsData, {
      style: getBuildingStyle,
      onEachFeature: function(feature, layer) {
        const props = feature.properties;
        const listingCount = props.listing_count || 0;
        const price = props.price || 0;
        const accommodates = props.accommodates || 0;
        const availability = props.availability_365 || 0;
        const capacityYear = accommodates * availability;
        
        const popupContent = `
          <div style="font-family: sans-serif; font-size: 12px;">
            <strong>Listings:</strong> ${listingCount}<br>
            <strong>Price (sum):</strong> ${price.toLocaleString()}<br>
            <strong>Accommodates:</strong> ${accommodates}<br>
            ${props.host_since ? `<strong>Earliest host since:</strong> ${props.host_since}<br>` : ''}
          </div>
        `;
        layer.bindPopup(popupContent);
        
        // Add flicker animation on mouseover
        layer.on({
          mouseover: function(e) {
            const layer = e.target;
            if (layer._path) {
              layer._path.classList.add('flicker-animation');
            }
          },
          mouseout: function(e) {
            const layer = e.target;
            if (layer._path) {
              layer._path.classList.remove('flicker-animation');
            }
          }
        });
      }
    }).addTo(map);
    
    // Fit map to bounds of Venice island (buildings)
    if (buildingsLayer && buildingsLayer.getBounds().isValid()) {
      map.fitBounds(buildingsLayer.getBounds(), {
        padding: [20, 20], // Add some padding around the bounds
        maxZoom: 15 // Limit max zoom to avoid zooming in too much
      });
    }
    
    console.log('Airbnb buildings GeoJSON loaded successfully:', buildingsData.features.length, 'features');
    
    // Create dashboard
    createDashboard();
    
    // Update pie chart after dashboard is created
    setTimeout(() => {
      updatePieChart();
    }, 200);
    
  } catch (error) {
    console.error('Error loading Airbnb buildings GeoJSON:', error);
    alert('Failed to load Airbnb buildings GeoJSON file. Please check the console for details.');
  }
}

// Helper function to calculate centroid of a geometry
function getCentroid(geometry) {
  if (geometry.type === 'Polygon') {
    const coords = geometry.coordinates[0];
    let lat = 0, lng = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      lat += coords[i][1];
      lng += coords[i][0];
    }
    return [lat / (coords.length - 1), lng / (coords.length - 1)];
  } else if (geometry.type === 'MultiPolygon') {
    // Get centroid of the largest polygon
    let maxArea = 0;
    let largestPolygon = null;
    for (const polygon of geometry.coordinates) {
      const coords = polygon[0];
      let area = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        area += coords[i][0] * coords[i + 1][1] - coords[i + 1][0] * coords[i][1];
      }
      area = Math.abs(area) / 2;
      if (area > maxArea) {
        maxArea = area;
        largestPolygon = polygon[0];
      }
    }
    if (largestPolygon) {
      let lat = 0, lng = 0;
      for (let i = 0; i < largestPolygon.length - 1; i++) {
        lat += largestPolygon[i][1];
        lng += largestPolygon[i][0];
      }
      return [lat / (largestPolygon.length - 1), lng / (largestPolygon.length - 1)];
    }
  }
  return null;
}

// Calculate Jenks breaks for neighborhood properties
function calculateNeighborhoodJenksBreaks(geojsonData) {
  const keys = [
    'listings_total',
    'total_guests_per_night',
    'guest_night_capacity_per_year',
    'total_price_per_night',
    'median_price_per_unit',
    'max_price_per_unit',
    'min_price_per_unit'
  ];
  
  keys.forEach(key => {
    const values = [];
    geojsonData.features.forEach(feature => {
      const value = feature.properties[key];
      if (value !== null && value !== undefined && !isNaN(value) && value > 0) {
        values.push(value);
      }
    });
    
    if (values.length > 0) {
      neighborhoodJenksBreaks[key] = calculateJenksBreaksFromData(values, 10);
    } else {
      neighborhoodJenksBreaks[key] = [];
    }
  });
  
  console.log('Neighborhood Jenks breaks calculated:', neighborhoodJenksBreaks);
}

// Get neighborhood style based on classification
function getNeighborhoodStyle(feature) {
  // Default style (initial color)
  const defaultStyle = {
          color: '#0066cc',
          weight: 2,
          opacity: 0.7,
          fillColor: '#3399ff',
          fillOpacity: 0.2  // 20% opacity
        };
  
  // If no classification is active, return default style
  if (!neighborhoodClassificationKey) {
    return defaultStyle;
  }
  
  const props = feature.properties;
  const value = props[neighborhoodClassificationKey];
  
  if (value === null || value === undefined || isNaN(value) || value <= 0) {
    return {
      ...defaultStyle,
      fillColor: '#999999' // Grey for no data
    };
  }
  
  // Get palette based on key
  let palette;
  const paletteMap = {
    'listings_total': generatePiYGPalette(10),
    'total_guests_per_night': generateRdYlBuPalette(10),
    'guest_night_capacity_per_year': generateSpectralPalette(10),
    'total_price_per_night': generateRdYlGnPalette(10),
    'median_price_per_unit': generateBrBGPalette(10),
    'max_price_per_unit': generatePuOrPalette(10),
    'min_price_per_unit': generateSet2Palette(10)
  };
  
  palette = paletteMap[neighborhoodClassificationKey] || generatePiYGPalette(10);
  
  const breaks = neighborhoodJenksBreaks[neighborhoodClassificationKey] || [];
  const fillColor = getColorForValue(value, breaks, palette);
  
  return {
    color: '#0066cc',
    weight: 2,
    opacity: 0.7,
    fillColor: fillColor,
    fillOpacity: 0.2  // 20% opacity
  };
}

// Update neighborhood colors
function updateNeighborhoodColors() {
  if (!barriLayer) {
    console.warn('barriLayer is null');
    return;
  }
  
  barriLayer.eachLayer(layer => {
    if (!layer.feature) {
      return;
    }
    
    const style = getNeighborhoodStyle(layer.feature);
    layer.setStyle(style);
    
    // Also update the path directly if it exists
    if (layer._path) {
      layer._path.setAttribute('fill', style.fillColor);
      layer._path.setAttribute('fill-opacity', style.fillOpacity);
      layer._path.setAttribute('stroke', style.color);
      layer._path.setAttribute('stroke-opacity', style.opacity);
    }
  });
  
  console.log('Neighborhood colors updated');
}

// Load and display barri GeoJSON
async function loadBarriGeoJSON() {
  try {
    const response = await fetch('/output/venice_barri_processed.geojson');
    const geojsonData = await response.json();
    
    // Store GeoJSON data globally
    neighborhoodGeoJSONData = geojsonData;
    
    // Calculate Jenks breaks for neighborhood properties
    calculateNeighborhoodJenksBreaks(geojsonData);
    
    // Create a GeoJSON layer group for labels
    barriLabelsLayer = L.layerGroup();
    
    // Create single tooltip element for all neighborhoods (if not already created)
    if (!neighborhoodTooltip) {
      neighborhoodTooltip = L.DomUtil.create('div', 'neighborhood-tooltip');
      neighborhoodTooltip.style.cssText = `
        position: absolute;
        background: rgba(0,0,0,0.9);
        color: white;
        padding: 8px 10px;
        border-radius: 5px;
        font-size: 11px;
        font-family: sans-serif;
        pointer-events: none;
        z-index: 10000;
        display: none;
        max-width: 250px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      `;
      document.body.appendChild(neighborhoodTooltip);
    }
    
    // Create a GeoJSON layer with dynamic styling
    barriLayer = L.geoJSON(geojsonData, {
      style: getNeighborhoodStyle,
      onEachFeature: function(feature, layer) {
        // Function to format value with unit
        function formatValue(key, value) {
          if (value === null || value === undefined || isNaN(value)) {
            return 'N/A';
          }
          
          if (key.includes('price')) {
            return `€${Math.round(value).toLocaleString()}`;
          } else if (key.includes('guests') || key === 'guest_night_capacity_per_year') {
            return `${Math.round(value).toLocaleString()} guests`;
          } else if (key === 'listings_total') {
            return `${Math.round(value).toLocaleString()} listings`;
          } else {
            return Math.round(value).toLocaleString();
          }
        }
        
        // Function to get display name for key
        function getDisplayName(key) {
          const displayNames = {
            'listings_total': 'Listings Total',
            'total_guests_per_night': 'Total Guests per Night',
            'guest_night_capacity_per_year': 'Guest-Night Capacity per Year',
            'total_price_per_night': 'Total Price per Night',
            'median_price_per_unit': 'Median Price per Unit',
            'max_price_per_unit': 'Max Price per Unit',
            'min_price_per_unit': 'Min Price per Unit'
          };
          return displayNames[key] || key;
        }
        
        // Function to update tooltip content
        function updateTooltipContent() {
          if (!neighborhoodClassificationKey) {
            return '';
          }
          
          const props = feature.properties;
          const keys = [
            'listings_total',
            'total_guests_per_night',
            'guest_night_capacity_per_year',
            'total_price_per_night',
            'median_price_per_unit',
            'max_price_per_unit',
            'min_price_per_unit'
          ];
          
          let content = '<div style="font-weight: bold; margin-bottom: 6px; border-bottom: 1px solid #555; padding-bottom: 4px;">';
          const name = props.neighbourhood || props.name || 'Neighborhood';
          content += name;
          content += '</div>';
          
          keys.forEach(key => {
            const value = props[key];
            const formattedValue = formatValue(key, value);
            const displayName = getDisplayName(key);
            content += `<div style="margin: 3px 0; display: flex; justify-content: space-between;">`;
            content += `<span style="color: #ccc;">${displayName}:</span>`;
            content += `<span style="font-weight: bold; margin-left: 10px;">${formattedValue}</span>`;
            content += `</div>`;
          });
          
          return content;
        }
        
        // Add CSS class for animation
        if (layer.setStyle) {
          layer.on({
            mouseover: function(e) {
              const layer = e.target;
              layer.setStyle({
                fillOpacity: 0.4,
                weight: 3
              });
              // Add blink animation class
              if (layer._path) {
                layer._path.classList.add('blink-animation');
              }
              
              // Show tooltip if classification is active
              if (neighborhoodClassificationKey && neighborhoodTooltip) {
                neighborhoodTooltip.innerHTML = updateTooltipContent();
                neighborhoodTooltip.style.display = 'block';
                
                // Position tooltip near mouse cursor
                const updateTooltipPosition = (e) => {
                  if (neighborhoodTooltip) {
                    neighborhoodTooltip.style.left = (e.originalEvent.clientX + 10) + 'px';
                    neighborhoodTooltip.style.top = (e.originalEvent.clientY - 10) + 'px';
                  }
                };
                
                updateTooltipPosition(e);
                layer.on('mousemove', updateTooltipPosition);
                layer._tooltipMousemove = updateTooltipPosition;
              }
            },
            mouseout: function(e) {
              const layer = e.target;
              const style = getNeighborhoodStyle(layer.feature);
              layer.setStyle({
                ...style,
                fillOpacity: 0.2,
                weight: 2
              });
              // Remove blink animation class
              if (layer._path) {
                layer._path.classList.remove('blink-animation');
              }
              
              // Hide tooltip
              if (neighborhoodTooltip) {
                neighborhoodTooltip.style.display = 'none';
              }
              if (layer._tooltipMousemove) {
                layer.off('mousemove', layer._tooltipMousemove);
                layer._tooltipMousemove = null;
              }
            }
          });
        }
        // Get the name from properties
        const name = feature.properties.neighbourhood || feature.properties.name || '';
        
        if (name) {
          // Calculate centroid for label placement
          const centroid = getCentroid(feature.geometry);
          
          if (centroid) {
            // Create a text label using DivIcon
            const textIcon = L.divIcon({
              className: 'barri-label',
              html: `<div style="
                color: white;
                font-weight: bold;
                font-size: 14px;
                text-align: center;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
                pointer-events: none;
                white-space: nowrap;
              ">${name}</div>`,
              iconSize: [200, 20],
              iconAnchor: [100, 10]
            });
            
            // Add marker at centroid with text label
            const labelMarker = L.marker(centroid, { icon: textIcon });
            barriLabelsLayer.addLayer(labelMarker);
          }
        }
      }
    }); // Don't add to map by default - neighborhoods are hidden initially
    
    // Don't add labels layer to map by default - neighborhoods are hidden initially
    
    console.log('Barri GeoJSON loaded successfully:', geojsonData.features.length, 'features');
    
    // Create neighborhood legend
    createNeighborhoodLegend();
  } catch (error) {
    console.error('Error loading barri GeoJSON:', error);
  }
}

// Load all GeoJSON files when the page loads
loadAirbnbBuildingsGeoJSON();
loadBarriGeoJSON();
