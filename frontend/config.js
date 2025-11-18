// Stadia Maps configuration
// For production, set VITE_STADIA_MAPS_API_KEY in Vercel environment variables
// For local development, you can modify the API key here or use .env.local file
export const stadiaMapsConfig = {
  apiKey: import.meta.env.VITE_STADIA_MAPS_API_KEY || 'b19a9ef4-83b1-41e7-99c4-51718847054b'
};

