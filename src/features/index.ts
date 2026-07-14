import type { FeatureModule } from './types.js';
import { securitiesFeature } from './securities/index.js';

/** All registered feature modules. Add new features here. */
export const allFeatures: FeatureModule[] = [securitiesFeature];
