export function getSpeciesColor(species: string): string {
  let hash = 0;
  for (let i = 0; i < species.length; i++) {
    hash = species.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 50%)`;
}

export function extractSpecies(properties: any): string | undefined {
  if (!properties) return undefined;
  
  // Direct checks first
  const directMatch = properties.species || properties.Species || properties.SPECIES || 
                      properties.plant_species || properties.crop || properties.Species_Name || properties.crp_lbl;
  if (directMatch) return String(directMatch);
  
  // Fuzzy checks
  for (const key of Object.keys(properties)) {
    const k = key.toLowerCase();
    if (k.includes('species') || k.includes('crop') || k.includes('plant') || k.includes('veg') || k.includes('class') || k.includes('type') || k.includes('label')) {
      const val = properties[key];
      if (typeof val === 'string' && val.trim() !== '') return val;
    }
  }
  
  // Check nested properties (sometimes GeoJSON wraps them)
  if (properties.properties && typeof properties.properties === 'object') {
    return extractSpecies(properties.properties);
  }
  
  return undefined;
}
