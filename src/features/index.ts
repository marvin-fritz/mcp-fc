import type { FeatureModule } from './types.js';
import { securitiesFeature } from './securities/index.js';
import { pricesFeature } from './prices/index.js';
import { financialsFeature } from './financials/index.js';
import { insiderFeature } from './insider/index.js';
import { fundsFeature } from './funds/index.js';
import { politicalFeature } from './political/index.js';
import { macroFeature } from './macro/index.js';

/** All registered feature modules. Add new features here. */
export const allFeatures: FeatureModule[] = [
  securitiesFeature,
  pricesFeature,
  financialsFeature,
  insiderFeature,
  fundsFeature,
  politicalFeature,
  macroFeature,
];
